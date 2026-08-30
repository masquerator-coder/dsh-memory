/**
 * dsh-memory — single-file SQLite store (zero npm deps, node:sqlite).
 *
 * Two layers share one db:
 *   - memories  (semantic): durable facts, dual-signal heat, three-level forgetting
 *   - episodes  (episodic): session summaries, time-driven forgetting
 *
 * Model: the `memory` tool writes DIRECTLY to the global store (cross-session
 * visible immediately — no consolidation gate on recall). Forgetting is a pure
 * rule-based background process that never blocks write or recall (L1/L2 LLM
 * condensation is dormant in v3).
 *
 * Concurrency: node:sqlite DatabaseSync is synchronous → within one process a
 * transaction is atomic. Cross-process subagents (separate workers) would need
 * an OS file lock — declared out of scope, not silently assumed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DAY_MS, heatOf, resolveForgetDays, shouldArchive, shouldDelete, shouldDemote } from './heat.js';
import { contentSimilarity, isLowQuality, qualityScore } from './quality.js';
import { DDL, migrateColumns, rebuildFts } from './schema.js';
export const DEFAULT_BUDGET = { tier0: 900, user: 400, memory: 500 };
/** Fallback group label for entries the model did not tag. */
const DEFAULT_TOPIC = 'general';
/** Topic labels are UI/index hints, not content — keep them short. */
const TOPIC_MAX = 40;
/** Minimum length (chars) both sides must meet before an id-less `replace` will
 * substring-match. Prevents a tiny fragment from silently overwriting a whole
 * entry (P0-3). */
const MIN_REPLACE_FRAGMENT = 8;
/** Cap on facts offered per L2 cluster — a giant untagged 'general' bucket must
 * not be dumped whole into the LLM prompt (P2-29). */
const MAX_FACTS_PER_CLUSTER = 25;
/** Episode recency half-life (days) for recall ranking. */
const EPISODE_RECENCY_DAYS = 90;
export function resolveDshHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}
/** Hard-content id: identical facts collapse instead of duplicating. */
export function contentId(content) {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
/** Escape SQL LIKE wildcards for use with an `ESCAPE '\'` clause. */
function escapeLike(s) {
    return String(s).replace(/[\\%_]/g, '\\$&');
}
function epiMult(epistemic) {
    if (epistemic === 'observed')
        return 1;
    if (epistemic === 'inferred')
        return 0.9;
    return 0.8;
}
export class MemoryStore {
    dir;
    dbPath;
    budget;
    windowDays;
    forgetDays;
    db;
    upsertMemStmt;
    upsertFtsStmt;
    upsertEpiStmt;
    upsertEpiFtsStmt;
    rowidStmt;
    epiRowidStmt;
    // P3-11 (review 2026-08-30): `get()` re-prepared its statement on every call
    // (23.6µs vs 6.7µs pre-compiled, 3.5x) and sits on the recall/touchAccess
    // hot path — prepare once here.
    getMemStmt;
    constructor(home = resolveDshHome(), budget = DEFAULT_BUDGET, windowDays = 30, forgetDays = resolveForgetDays()) {
        this.dir = join(home, 'memory');
        mkdirSync(this.dir, { recursive: true });
        this.dbPath = join(this.dir, 'memory.db');
        this.budget = budget;
        this.windowDays = windowDays;
        this.forgetDays = forgetDays;
        // P1-15: node:sqlite is experimental before Node 24 and unavailable before
        // 22.5. Give a clear error (vs. a raw crash) and rely on `engines`/ability.
        try {
            this.db = new DatabaseSync(this.dbPath);
        }
        catch (err) {
            throw new Error(`dsh-memory: cannot open SQLite store — node:sqlite requires Node >=22.5 (found ${process.version}). ${err instanceof Error ? err.message : String(err)}`);
        }
        this.db.exec('PRAGMA journal_mode=WAL');
        this.db.exec('PRAGMA busy_timeout=3000');
        this.db.exec(DDL);
        migrateColumns(this.db);
        rebuildFts(this.db);
        this.upsertMemStmt = this.db.prepare(`
      INSERT INTO memories
        (id, layer, kind, tier, topic, content, importance, quality, epistemic, heat,
         created, updated, last_accessed, archived, low_quality, window_freq, window_start,
         archived_at, session_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        layer=excluded.layer, kind=excluded.kind, tier=excluded.tier, topic=excluded.topic,
        content=excluded.content, importance=excluded.importance, quality=excluded.quality,
        epistemic=excluded.epistemic, heat=excluded.heat, updated=excluded.updated,
        last_accessed=excluded.last_accessed, archived=excluded.archived,
        low_quality=excluded.low_quality, window_freq=excluded.window_freq,
        window_start=excluded.window_start, archived_at=excluded.archived_at,
        session_id=excluded.session_id
    `);
        // FTS5 virtual tables reject UPSERT — use INSERT OR REPLACE keyed by the
        // content table's implicit rowid (id TEXT PRIMARY KEY still has one).
        this.upsertFtsStmt = this.db.prepare('INSERT OR REPLACE INTO mem_fts(rowid, content, topic) VALUES (?,?,?)');
        this.rowidStmt = this.db.prepare('SELECT rowid AS r FROM memories WHERE id = ?');
        this.upsertEpiStmt = this.db.prepare(`
      INSERT INTO episodes
        (id, session_id, ts, summary, tools_used, topic, extracted, archived, archived_at, created)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        session_id=excluded.session_id, ts=excluded.ts, summary=excluded.summary,
        tools_used=excluded.tools_used, topic=excluded.topic, extracted=excluded.extracted,
        archived=excluded.archived, archived_at=excluded.archived_at, created=excluded.created
    `);
        this.upsertEpiFtsStmt = this.db.prepare('INSERT OR REPLACE INTO ep_fts(rowid, summary, topic) VALUES (?,?,?)');
        this.epiRowidStmt = this.db.prepare('SELECT rowid AS r FROM episodes WHERE id = ?');
        this.getMemStmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
    }
    close() {
        this.db.close();
    }
    // ---- row mapping ---------------------------------------------------------
    rowToEntry(r) {
        return {
            id: String(r.id),
            layer: r.layer,
            kind: r.kind,
            tier: Number(r.tier),
            topic: String(r.topic),
            content: String(r.content),
            importance: Number(r.importance),
            quality: Number(r.quality),
            epistemic: r.epistemic,
            heat: Number(r.heat),
            created: Number(r.created),
            updated: Number(r.updated),
            last_accessed: Number(r.last_accessed),
            archived: Number(r.archived) === 1,
            low_quality: Number(r.low_quality) === 1,
            window_freq: Number(r.window_freq ?? 0),
            window_start: Number(r.window_start ?? 0),
            archived_at: r.archived_at ? Number(r.archived_at) : undefined,
            session_id: r.session_id ? String(r.session_id) : undefined,
        };
    }
    rowToEpisode(r) {
        return {
            id: String(r.id),
            session_id: String(r.session_id),
            ts: Number(r.ts),
            summary: String(r.summary),
            tools_used: r.tools_used ? String(r.tools_used) : undefined,
            topic: String(r.topic),
            // P3-13: three-state (0/1/2) — boolean coercion made degraded (2)
            // indistinguishable from untouched (0) on read-back.
            extracted: Number(r.extracted),
            archived: Number(r.archived) === 1,
            archived_at: r.archived_at ? Number(r.archived_at) : undefined,
            created: Number(r.created),
        };
    }
    // ---- reads (memories) ----------------------------------------------------
    get(id) {
        const r = this.getMemStmt.get(id);
        return r ? this.rowToEntry(r) : undefined;
    }
    list(filter = {}) {
        const clauses = ['1=1'];
        const params = [];
        if (filter.layer) {
            clauses.push('layer = ?');
            params.push(filter.layer);
        }
        if (filter.tier !== undefined) {
            clauses.push('tier = ?');
            params.push(filter.tier);
        }
        if (filter.kind) {
            clauses.push('kind = ?');
            params.push(filter.kind);
        }
        if (filter.includeArchived !== true)
            clauses.push('archived = 0');
        if (filter.includeLowQuality === false)
            clauses.push('low_quality = 0');
        const rows = this.db.prepare(`SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY updated DESC, rowid DESC`).all(...params);
        return rows.map(r => this.rowToEntry(r));
    }
    activeEntries() {
        return this.list({ includeArchived: false, includeLowQuality: true });
    }
    count() {
        const r = this.db.prepare('SELECT COUNT(*) AS c FROM memories WHERE archived = 0').get();
        return Number(r.c);
    }
    /** Active (non-archived) episode count, without loading rows (P2-25). */
    episodeCount() {
        const r = this.db.prepare('SELECT COUNT(*) AS c FROM episodes WHERE archived = 0').get();
        return Number(r.c);
    }
    /** Tier-0 (injectable, non-archived, non-low-quality) usage.
     *  R4 (review 2026-08-30): SQL aggregate — the old version loaded and JS-mapped
     *  every tier-0 row on each call (batch/tools both call this per write). */
    usage() {
        const rows = this.db.prepare('SELECT layer AS l, SUM(LENGTH(content)) AS n FROM memories WHERE tier = 0 AND archived = 0 AND low_quality = 0 GROUP BY layer').all();
        let user = 0;
        let memory = 0;
        for (const r of rows) {
            if (r.l === 'user')
                user += Number(r.n ?? 0);
            else
                memory += Number(r.n ?? 0);
        }
        const total = user + memory;
        return { user, memory, total, pct: this.budget.tier0 > 0 ? Math.round((total / this.budget.tier0) * 100) : 0 };
    }
    topicsIndex() {
        const rows = this.db.prepare('SELECT topic, COUNT(*) AS c FROM memories WHERE tier = 1 AND archived = 0 GROUP BY topic ORDER BY c DESC').all();
        return rows.map(r => ({ topic: String(r.topic), count: Number(r.c) }));
    }
    /** Bounded dedup candidate set (P2-16): only rows sharing the head of `content`
     *  are compared for the duplicate penalty, so add/replace cost stops scaling with
     *  library size. (Content-equality dedup — P0-2 — is exact and separate.)
     *  R4 (review 2026-08-30): the old `LIKE '%head%'` had a leading wildcard and
     *  full-scanned every row; this prefix-anchored range rides idx_mem_content. */
    nearCandidates(content, cap = 8) {
        const slice = content.slice(0, 12).trim();
        if (!slice)
            return [];
        const rows = this.db.prepare("SELECT * FROM memories WHERE archived = 0 AND content >= ? AND content < ? LIMIT ?").all(slice, `${slice}\uffff`, cap);
        return rows.map(r => this.rowToEntry(r));
    }
    // ---- writes (memories) ---------------------------------------------------
    autoTier(layer, importance, quality, kind, low) {
        if (low)
            return 1;
        if (layer === 'user')
            return 0;
        if (importance >= 4 && quality >= 60 && (kind === 'preference' || kind === 'env'))
            return 0;
        return 1;
    }
    writeMemory(id, fields) {
        this.upsertMemStmt.run(id, fields.layer, fields.kind, fields.tier, fields.topic, fields.content, fields.importance, fields.quality, fields.epistemic, fields.heat, fields.created, fields.updated, fields.last_accessed, fields.archived ? 1 : 0, fields.low_quality ? 1 : 0, fields.window_freq, fields.window_start, fields.archived_at ?? null, fields.session_id ?? null);
        const rowid = Number(this.rowidStmt.get(id).r);
        this.upsertFtsStmt.run(rowid, fields.content, fields.topic);
    }
    hardDeleteMemory(id) {
        const row = this.rowidStmt.get(id);
        const r = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
        if (r.changes > 0 && row)
            this.db.prepare('DELETE FROM mem_fts WHERE rowid = ?').run(Number(row.r));
        // P3-15 (review 2026-08-30): cascade the correction trail — the memory row is
        // physically gone, so leaving failure_memories rows only extends other
        // entries' observation windows with references to a dead id. (remove force
        // and forgetRun's hard-delete both land here.)
        if (r.changes > 0)
            this.db.prepare('DELETE FROM failure_memories WHERE memory_id = ?').run(id);
    }
    applyOne(op, now) {
        if (op.action === 'add' || op.action === 'replace') {
            const content = (op.content ?? '').trim();
            if (!content)
                return { ok: false, error: 'content is required' };
            const layer = op.layer ?? 'memory';
            const kind = op.kind ?? inferKind(content);
            const importance = op.importance ?? 3;
            const epistemic = op.epistemic ?? 'observed';
            const topic = op.topic === '' ? '' : (op.topic ?? '').trim().slice(0, TOPIC_MAX) || DEFAULT_TOPIC;
            if (op.action === 'add') {
                // P0-2: dedup on exact content (source of truth), not merely the
                // content-hash id. `contentId(content)` can go stale after a `replace`
                // (which keeps the row's original id), so a row might hold this content
                // under a different id — re-adding that content must update it, never
                // insert a duplicate. Keep the matched row's id stable (external handle).
                const cid = contentId(content);
                let existing = this.get(cid);
                if (existing && existing.content !== content)
                    existing = undefined; // cid row belongs to a different fact (drift) — don't trust it
                if (!existing) {
                    const dup = this.db.prepare('SELECT * FROM memories WHERE content = ? LIMIT 1').get(content);
                    if (dup)
                        existing = this.rowToEntry(dup);
                }
                const id = existing ? existing.id : cid;
                const quality = existing ? existing.quality : qualityScore(content, this.nearCandidates(content));
                const low = isLowQuality(quality);
                const tier = existing ? (low ? 1 : (op.tier ?? existing.tier)) : (op.tier ?? this.autoTier(layer, importance, quality, kind, low));
                if (existing) {
                    this.writeMemory(id, {
                        layer, kind, tier, topic, content, importance, quality, epistemic,
                        heat: heatOf(existing, this.forgetDays), created: existing.created, updated: now,
                        // R1 (review 2026-08-30): re-adding content that matches an ARCHIVED
                        // entry reactivates it — the tool says "已记入", so the fact must become
                        // visible/recallable again. Keeping the old archived=1 silently broke
                        // the write contract (recorded but never retrievable).
                        last_accessed: existing.last_accessed, archived: false, low_quality: low,
                        window_freq: existing.window_freq, window_start: existing.window_start,
                        archived_at: undefined, session_id: op.sessionId ?? existing.session_id,
                    });
                }
                else {
                    this.writeMemory(id, {
                        layer, kind, tier, topic, content, importance, quality, epistemic,
                        heat: 1, created: now, updated: now, last_accessed: now, archived: false, low_quality: low,
                        window_freq: 0, window_start: 0, session_id: op.sessionId,
                    });
                }
                // P2-9: surface low_quality at the write boundary — "已记入" must not
                // hide "recorded but excluded from default recall/injection".
                return low ? { ok: true, lowQualityId: id } : { ok: true };
            }
            // replace
            let target = op.id ? this.get(op.id) : undefined;
            if (!target && op.id)
                return { ok: false, error: `no entry with id ${op.id}` };
            if (!target) {
                // P0-3: never silently match by a tiny fragment — a 1-char content could
                // overwrite a whole entry with a fragment. Only substring-match when BOTH
                // sides are ≥ MIN_REPLACE_FRAGMENT, else refuse and demand an explicit id.
                if (content.length >= MIN_REPLACE_FRAGMENT) {
                    target = this.activeEntries().find(e => e.content.length >= MIN_REPLACE_FRAGMENT && (e.content.includes(content) || content.includes(e.content))) ?? undefined;
                }
                if (!target)
                    return { ok: false, error: `replace without id needs an unambiguous ≥${MIN_REPLACE_FRAGMENT}-char fragment to target; pass id for an exact replace` };
            }
            if (!target)
                return { ok: false, error: 'no entry matched for replace' };
            const oldContent = target.content;
            const quality = qualityScore(content, this.nearCandidates(content));
            const low = isLowQuality(quality);
            const tier = low ? 1 : (op.tier ?? target.tier);
            if (content !== oldContent) {
                this.recordFailure(target.id, oldContent, content);
            }
            this.writeMemory(target.id, {
                layer, kind, tier, topic: topic || target.topic, content, importance, quality, epistemic,
                heat: heatOf(target, this.forgetDays), created: target.created, updated: now,
                last_accessed: target.last_accessed, archived: target.archived, low_quality: low,
                window_freq: target.window_freq, window_start: target.window_start,
                archived_at: target.archived_at, session_id: op.sessionId ?? target.session_id,
            });
            // P2-9: same low-quality surfacing on replace.
            return low ? { ok: true, lowQualityId: target.id } : { ok: true };
        }
        if (op.action === 'remove') {
            const target = op.id ? this.get(op.id) : undefined;
            if (!target)
                return { ok: false, error: `no entry with id ${op.id}` };
            if (op.force) {
                this.hardDeleteMemory(target.id);
            }
            else {
                this.db.prepare('UPDATE memories SET archived = 1, archived_at = ?, updated = ? WHERE id = ?').run(now, now, target.id);
            }
            return { ok: true };
        }
        return { ok: false, error: `unsupported action ${String(op.action)}` };
    }
    /**
     * Make the tier-0 injection budget fit by demoting the coldest eligible entries.
     * Three budgets are enforced (P1-7): the memory layer, the user layer (user is
     * immortal — never deleted, but CAN be pushed out of the resident injected set
     * under pressure), and the whole-section cap. `importance >= 5` is the protected
     * resident core and is never demoted — so if those alone overflow a bucket, the
     * batch is rejected (overflow becomes truly reachable, P1-8). Returns the ids
     * demoted and whether budget still exceeds after demotion (P1-9 surfaces them).
     */
    enforceBudget(now) {
        const demoted = [];
        const done = new Set();
        // Single load (P2-19): all tier-0 residents once; importance >= 5 is the
        // protected resident core (never demoted) but still counts toward usage.
        const all = this.list({ tier: 0, includeArchived: false, includeLowQuality: false });
        const demotable = all.filter(e => e.importance < 5)
            .sort((a, b) => heatOf(a, this.forgetDays, now) - heatOf(b, this.forgetDays, now) || a.importance - b.importance);
        const totalOf = (pred) => {
            let n = 0;
            for (const e of all) {
                if (!done.has(e.id) && pred(e))
                    n += e.content.length;
            }
            return n;
        };
        const memUse = () => totalOf(e => e.layer !== 'user');
        const usrUse = () => totalOf(e => e.layer === 'user');
        const demote = (e) => {
            this.db.prepare('UPDATE memories SET tier = 1 WHERE id = ?').run(e.id);
            done.add(e.id);
            demoted.push(e.id);
        };
        const squeeze = (pred, over) => {
            for (const e of demotable) {
                if (done.has(e.id) || !pred(e) || !over())
                    continue;
                demote(e);
            }
        };
        squeeze(e => e.layer !== 'user', () => memUse() > this.budget.memory);
        squeeze(e => e.layer === 'user', () => usrUse() > this.budget.user);
        squeeze(() => true, () => memUse() + usrUse() > this.budget.tier0);
        const over = memUse() > this.budget.memory || usrUse() > this.budget.user || (memUse() + usrUse()) > this.budget.tier0;
        return { demoted, over };
    }
    /** Model-facing write batch; lands globally and immediately.
     *  R5 (review 2026-08-30): SAVEPOINT instead of BEGIN/COMMIT — safe both
     *  standalone and nested inside a caller-held transaction (same pattern as
     *  writeEpisode, P1-12). The old BEGIN IMMEDIATE threw "cannot start a
     *  transaction within a transaction" when composed. */
    batch(ops, sessionId) {
        const now = Date.now();
        const applied = [];
        const rejected = [];
        // P2-9: ids written/updated with low_quality=1, surfaced to the tool layer.
        const lowQualityIds = [];
        this.db.exec('SAVEPOINT dsh_batch');
        try {
            for (const op of ops) {
                if (op.action === 'list')
                    continue;
                const mapped = sessionId ? { ...op, sessionId } : op;
                const res = this.applyOne(mapped, now);
                if (res.ok) {
                    applied.push(mapped);
                    if (res.lowQualityId)
                        lowQualityIds.push(res.lowQualityId);
                }
                else
                    rejected.push({ op: mapped, reason: res.error });
            }
            const { demoted, over } = this.enforceBudget(now);
            if (over) {
                this.db.exec('ROLLBACK TO dsh_batch');
                this.db.exec('RELEASE dsh_batch');
                // R4: compute only when actually reported — after rollback the state is
                // exactly the pre-batch snapshot this return describes.
                const before = this.activeEntries();
                const usage = this.usage();
                return { applied: [], rejected: ops.map(o => ({ op: o, reason: 'memory budget exceeded' })), entries: before, overflowed: true, demoted: [], lowQuality: [], usage };
            }
            this.db.exec('RELEASE dsh_batch');
            // R4 (review 2026-08-30): `entries` is only consumed on the overflow path
            // (tools.ts) — evaluate lazily once on first access so a plain add does
            // not pay a full active-set load per batch. Same value when read.
            const store = this;
            let entriesCache;
            const res = {
                applied, rejected, overflowed: false, demoted, lowQuality: lowQualityIds, usage: this.usage(),
                get entries() { return (entriesCache ??= store.activeEntries()); },
            };
            return res;
        }
        catch (err) {
            try {
                this.db.exec('ROLLBACK TO dsh_batch');
            }
            catch { /* noop */ }
            try {
                this.db.exec('RELEASE dsh_batch');
            }
            catch { /* noop */ }
            throw err;
        }
    }
    // ---- recall (memories) ---------------------------------------------------
    /** Refresh last_accessed + sliding-window frequency for recalled entries. */
    touchAccess(ids) {
        const now = Date.now();
        const windowMs = this.windowDays * DAY_MS;
        const upd = this.db.prepare('UPDATE memories SET last_accessed = ?, window_freq = ?, window_start = ? WHERE id = ?');
        for (const id of ids) {
            const e = this.get(id);
            if (!e)
                continue;
            let freq;
            let start;
            if (e.window_start === 0 || now - e.window_start > windowMs) {
                freq = 1;
                start = now;
            }
            else {
                freq = e.window_freq + 1;
                start = e.window_start;
            }
            upd.run(now, freq, start, id);
        }
    }
    recall(query, opts = {}) {
        const topK = opts.topK ?? 8;
        const weighting = opts.epistemicWeighting ?? true;
        const now = Date.now();
        const qLower = query.toLowerCase();
        const keywords = query.split(/[\s,，。;；、]+/).map(k => k.toLowerCase()).filter(Boolean);
        // P2-17: candidate pre-filter in SQL (FTS ∪ any-substring) so recall does NOT
        // load + scan the whole library in JS. base>0 iff the row is FTS-hit OR its
        // content/topic contains the raw query OR any keyword — all expressed below.
        const seen = new Set();
        const candidates = [];
        const push = (e) => {
            if (!e || seen.has(e.id))
                return;
            seen.add(e.id);
            candidates.push(e);
        };
        // FTS hit rows fetched one-shot (P1-5): the old version collected ids then
        // re-fetched each row via get() — two queries per hit.
        const ftsIds = new Set();
        try {
            const q = query.split(/\s+/).filter(Boolean).map(t => `"${t.replaceAll('"', '""')}"`).join(' ');
            if (q) {
                for (const row of this.db.prepare('SELECT * FROM memories WHERE rowid IN (SELECT rowid FROM mem_fts WHERE mem_fts MATCH ?)').all(q)) {
                    const e = this.rowToEntry(row);
                    ftsIds.add(e.id);
                    if (opts.includeArchived !== true && e.archived)
                        continue;
                    if (opts.includeLowQuality !== true && e.low_quality)
                        continue;
                    push(e);
                }
            }
        }
        catch { /* MATCH lex error → substring layer covers */ }
        // Substring candidates via SQL LIKE over content/topic.
        const baseClauses = ['1=1'];
        if (opts.includeArchived !== true)
            baseClauses.push('archived = 0');
        if (opts.includeLowQuality !== true)
            baseClauses.push('low_quality = 0');
        const like = "(\"content\" LIKE ? ESCAPE '\\' OR \"topic\" LIKE ? ESCAPE '\\')";
        const ors = [];
        const params = [];
        const addTerm = (s) => {
            const e = escapeLike(s);
            ors.push(like);
            params.push(`%${e}%`, `%${e}%`);
        };
        addTerm(qLower);
        for (const k of keywords)
            addTerm(k);
        const sql = `SELECT * FROM memories WHERE ${baseClauses.join(' AND ')} AND (${ors.join(' OR ')})`;
        for (const r of this.db.prepare(sql).all(...params))
            push(this.rowToEntry(r));
        if (candidates.length === 0)
            return [];
        const scored = [];
        for (const e of candidates) {
            let base = 0;
            if (ftsIds.has(e.id))
                base += 6;
            const text = `${e.topic}\n${e.content}`.toLowerCase();
            if (text.includes(qLower))
                base += 4;
            for (const k of keywords)
                if (text.includes(k))
                    base += 1;
            if (base === 0)
                continue;
            const heat = heatOf(e, this.forgetDays, now);
            const score = base * (weighting ? epiMult(e.epistemic) : 1) * (0.5 + 0.5 * heat);
            scored.push({ entry: e, score });
        }
        scored.sort((a, b) => b.score - a.score || b.entry.updated - a.entry.updated || (a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0));
        const top = scored.slice(0, topK);
        if (top.length > 0)
            this.touchAccess(top.map(h => h.entry.id));
        return top;
    }
    // ---- episodes ------------------------------------------------------------
    writeEpisode(id, fields) {
        // P1-12: episode row + its FTS row must land atomically, or a crash between
        // them leaves episodes/ep_fts inconsistent (recall silently drops rows).
        // SAVEPOINT (not BEGIN) so this is safe both standalone and when the caller
        // is already inside a transaction (e.g. an enclosing batch).
        this.db.exec('SAVEPOINT ep_write');
        try {
            this.upsertEpiStmt.run(id, fields.session_id, fields.ts, fields.summary, fields.tools_used ?? null, fields.topic, fields.extracted, fields.archived ? 1 : 0, fields.archived_at ?? null, fields.created);
            const rowid = Number(this.epiRowidStmt.get(id).r);
            this.upsertEpiFtsStmt.run(rowid, fields.summary, fields.topic);
            this.db.exec('RELEASE ep_write');
        }
        catch (err) {
            try {
                this.db.exec('ROLLBACK TO ep_write');
            }
            catch { /* noop */ }
            try {
                this.db.exec('RELEASE ep_write');
            }
            catch { /* noop */ }
            throw err;
        }
    }
    addEpisode(fields) {
        const now = Date.now();
        const id = contentId(`${fields.sessionId}:${now}`);
        const ep = {
            id,
            session_id: fields.sessionId,
            ts: now,
            summary: fields.summary.trim(),
            tools_used: fields.toolsUsed,
            topic: (fields.topic ?? '').trim().slice(0, TOPIC_MAX) || DEFAULT_TOPIC,
            extracted: 0,
            archived: false,
            created: now,
        };
        this.writeEpisode(id, ep);
        return ep;
    }
    listEpisodes(filter = {}) {
        const clauses = ['1=1'];
        if (filter.includeArchived !== true)
            clauses.push('archived = 0');
        const rows = this.db.prepare(`SELECT * FROM episodes WHERE ${clauses.join(' AND ')} ORDER BY ts DESC, rowid DESC`).all();
        return rows.map(r => this.rowToEpisode(r));
    }
    /** P1-5 (review 2026-08-30): candidate pre-filter pushed into SQL — FTS hits
     *  fetched one-shot, substring candidates via LIKE over summary/topic. The old
     *  version loaded EVERY active episode into JS before scoring (4000 rows →
     *  8.6ms/call, strictly linear; the semantic recall path is O(hits) at 0.05ms).
     *  Scoring itself is unchanged — same FTS/substring/keyword base + recency. */
    recallEpisodes(query, opts = {}) {
        const topK = opts.topK ?? 8;
        const seen = new Set();
        const candidates = [];
        const push = (ep) => {
            if (!ep || seen.has(ep.id))
                return;
            seen.add(ep.id);
            candidates.push(ep);
        };
        const ftsIds = new Set();
        try {
            const q = query.split(/\s+/).filter(Boolean).map(t => `"${t.replaceAll('"', '""')}"`).join(' ');
            if (q) {
                for (const row of this.db.prepare('SELECT * FROM episodes WHERE rowid IN (SELECT rowid FROM ep_fts WHERE ep_fts MATCH ?)').all(q)) {
                    const ep = this.rowToEpisode(row);
                    ftsIds.add(ep.id);
                    if (ep.archived)
                        continue;
                    push(ep);
                }
            }
        }
        catch { /* MATCH lex error → substring layer covers */ }
        // Substring candidates via SQL LIKE over summary/topic (only active rows).
        const qLower = query.toLowerCase();
        const keywords = query.split(/[\s,，。;；、]+/).map(k => k.toLowerCase()).filter(Boolean);
        const like = "(\"summary\" LIKE ? ESCAPE '\\' OR \"topic\" LIKE ? ESCAPE '\\')";
        const ors = [];
        const params = [];
        const addTerm = (s) => {
            const e = escapeLike(s);
            ors.push(like);
            params.push(`%${e}%`, `%${e}%`);
        };
        addTerm(qLower);
        for (const k of keywords)
            addTerm(k);
        const sql = `SELECT * FROM episodes WHERE archived = 0 AND (${ors.join(' OR ')})`;
        for (const r of this.db.prepare(sql).all(...params))
            push(this.rowToEpisode(r));
        if (candidates.length === 0)
            return [];
        const scored = [];
        const now = Date.now();
        for (const ep of candidates) {
            let base = 0;
            if (ftsIds.has(ep.id))
                base += 6;
            const text = `${ep.topic}\n${ep.summary}`.toLowerCase();
            if (text.includes(qLower))
                base += 4;
            for (const k of keywords)
                if (text.includes(k))
                    base += 1;
            if (base === 0)
                continue;
            const recency = Math.exp(-(now - ep.ts) / (EPISODE_RECENCY_DAYS * DAY_MS));
            const score = base * (0.5 + 0.5 * recency);
            scored.push({ episode: ep, score });
        }
        scored.sort((a, b) => b.score - a.score || b.episode.ts - a.episode.ts || (a.episode.id < b.episode.id ? 1 : a.episode.id > b.episode.id ? -1 : 0));
        return scored.slice(0, topK);
    }
    hardDeleteEpisode(id) {
        // P1-12: delete episode + FTS atomically; SAVEPOINT stays safe when the
        // caller (forgetRun) already holds a transaction.
        this.db.exec('SAVEPOINT ep_delete');
        try {
            const row = this.epiRowidStmt.get(id);
            const r = this.db.prepare('DELETE FROM episodes WHERE id = ?').run(id);
            if (r.changes > 0 && row)
                this.db.prepare('DELETE FROM ep_fts WHERE rowid = ?').run(Number(row.r));
            this.db.exec('RELEASE ep_delete');
        }
        catch (err) {
            try {
                this.db.exec('ROLLBACK TO ep_delete');
            }
            catch { /* noop */ }
            try {
                this.db.exec('RELEASE ep_delete');
            }
            catch { /* noop */ }
            throw err;
        }
    }
    // ---- L1/L2 refine support (zero LLM — pure scheduling, reading, audit) ----
    /**
     * Episodes awaiting L1 extraction, oldest first. `extracted = 0` (untouched)
     * are the pending queue; `== 2` (degraded) are retried only when
     * retryDegraded is set — so a hot LLM outage degrades cleanly without
     * hammering the route every pass. (P3-14: comment previously stated the
     * exact opposite of what the SQL does.)
     */
    listEpisodesForRefine(opts = {}) {
        const status = opts.retryDegraded ? 'extracted IN (0, 2)' : 'extracted = 0';
        const limit = opts.limit && opts.limit > 0 ? `LIMIT ${Math.floor(opts.limit)}` : '';
        const rows = this.db.prepare(`SELECT * FROM episodes WHERE archived = 0 AND ${status} ORDER BY ts ASC ${limit}`).all();
        return rows.map(r => this.rowToEpisode(r));
    }
    /** Record L1 processing state on an episode (0 untouched → 1 extracted → 2 degraded-skip). */
    markEpisodeExtracted(id, status) {
        this.db.prepare('UPDATE episodes SET extracted = ? WHERE id = ?').run(status, id);
    }
    /** Semantic clusters (same topic, ≥ min members) as L2 merge candidates. */
    semanticClusters(opts = {}) {
        const min = opts.min ?? 2;
        const byTopic = new Map();
        for (const e of this.list({ includeArchived: false, includeLowQuality: opts.includeLowQuality === true })) {
            const arr = byTopic.get(e.topic) ?? [];
            arr.push({ id: e.id, content: e.content, kind: e.kind, importance: e.importance });
            byTopic.set(e.topic, arr);
        }
        const out = [];
        for (const [topic, facts] of byTopic) {
            if (facts.length >= min)
                out.push({ seedId: facts[0].id, topic, facts: facts.slice(0, MAX_FACTS_PER_CLUSTER) });
        }
        out.sort((a, b) => b.facts.length - a.facts.length);
        return (opts.limit && opts.limit > 0) ? out.slice(0, opts.limit) : out;
    }
    /** Append one L1/L2 LLM-decision audit row (degraded runs record null route). */
    writeRefineRun(fields) {
        const r = this.db.prepare('INSERT INTO refine_runs(ts, level, source_id, prompt_sha, llm_route, decisions, status) VALUES (?,?,?,?,?,?,?)').run(Date.now(), fields.level, fields.sourceId ?? null, fields.promptSha ?? null, fields.route ?? null, fields.decisions, fields.status);
        return Number(r.lastInsertRowid);
    }
    /** Prior audit rows for one refine source — bounded-retry accounting for L1
     *  episodes whose facts were rejected (e.g. tier-0 budget overflow). Counts
     *  refine_runs rows; the 180-day audit pruning also bounds this counter. */
    refineAttemptCount(sourceId) {
        const r = this.db.prepare('SELECT COUNT(*) AS c FROM refine_runs WHERE source_id = ?').get(sourceId);
        return Number(r.c);
    }
    // ---- correction trail ----------------------------------------------------
    recordFailure(memoryId, oldContent, newContent) {
        this.db.prepare('INSERT INTO failure_memories(memory_id, old_content, new_content, corrected_at) VALUES (?,?,?,?)')
            .run(memoryId, oldContent, newContent, Date.now());
    }
    failureTrail() {
        const rows = this.db.prepare('SELECT memory_id, old_content, new_content, corrected_at FROM failure_memories').all();
        return rows.map(r => ({
            memoryId: String(r.memory_id),
            oldContent: String(r.old_content ?? ''),
            newContent: String(r.new_content ?? ''),
            correctedAt: Number(r.corrected_at),
        }));
    }
    /** True when a failure trail still references this content (corrected-once → extend life). */
    hasPendingCorrection(content) {
        for (const f of this.failureTrail()) {
            const oldC = f.oldContent.trim();
            if (!oldC)
                continue;
            if (contentSimilarity(oldC, content) >= 0.5 || content.includes(oldC) || oldC.includes(content))
                return true;
        }
        return false;
    }
    // ---- active forgetting (three-level ladder + two faces) ------------------
    forgetRun(cfg, now = Date.now()) {
        const forgetDays = resolveForgetDays(cfg.forgetDays);
        const observeDays = cfg.observeDays ?? 30;
        const retentionDays = cfg.episodeRetentionDays ?? 180;
        const decisions = [];
        let demoted = 0;
        let archivedMem = 0;
        let deletedMem = 0;
        let archivedEpi = 0;
        let deletedEpi = 0;
        this.db.exec('BEGIN IMMEDIATE');
        try {
            // 1. demote cold tier-0 memories
            for (const e of this.list({ tier: 0, includeArchived: false, includeLowQuality: true })) {
                if (shouldDemote(e, forgetDays, now)) {
                    this.db.prepare('UPDATE memories SET tier = 1, updated = ? WHERE id = ?').run(now, e.id);
                    demoted += 1;
                    decisions.push(`demote:${e.id}`);
                }
            }
            // 2. archive cold memories
            for (const e of this.activeEntries()) {
                if (shouldArchive(e, forgetDays, now)) {
                    this.db.prepare('UPDATE memories SET archived = 1, archived_at = ?, updated = ? WHERE id = ?').run(now, now, e.id);
                    archivedMem += 1;
                    decisions.push(`archive:${e.id}`);
                }
            }
            // P2-18: load the correction trail once outside the delete loop — it was
            // re-querying the whole failure_memories table for every candidate entry.
            const trail = this.failureTrail();
            const pendingCorrection = (content) => {
                for (const f of trail) {
                    const oldC = f.oldContent.trim();
                    if (!oldC)
                        continue;
                    if (contentSimilarity(oldC, content) >= 0.5 || content.includes(oldC) || oldC.includes(content))
                        return true;
                }
                return false;
            };
            // 3. hard-delete archived memories past observation
            for (const e of this.list({ includeArchived: true, includeLowQuality: true })) {
                if (!e.archived)
                    continue;
                if (shouldDelete(e, observeDays, pendingCorrection(e.content), now)) {
                    // P1-13: snapshot BEFORE physical delete — content is unrecoverable after
                    // hardDeleteMemory, so this row is the only durable evidence for rollback.
                    this.db.prepare('INSERT INTO forget_deleted(ts, memory_id, content, topic, importance, quality, heat, reason) VALUES (?,?,?,?,?,?,?,?)').run(now, e.id, e.content, e.topic, e.importance, e.quality, heatOf(e, this.forgetDays, now), 'observed-observation-passed');
                    this.hardDeleteMemory(e.id);
                    deletedMem += 1;
                    decisions.push(`delete:${e.id}`);
                }
            }
            // 4. archive old episodes (time-driven)
            for (const ep of this.listEpisodes({ includeArchived: false })) {
                if (now - ep.ts > retentionDays * DAY_MS) {
                    this.db.prepare('UPDATE episodes SET archived = 1, archived_at = ? WHERE id = ?').run(now, ep.id);
                    archivedEpi += 1;
                    decisions.push(`ep-archive:${ep.id}`);
                }
            }
            // 5. hard-delete archived episodes past observation
            for (const ep of this.listEpisodes({ includeArchived: true })) {
                if (!ep.archived || ep.archived_at === undefined)
                    continue;
                if (now - ep.archived_at > observeDays * DAY_MS) {
                    // R7 (review 2026-08-30, P2-10): snapshot BEFORE physical delete —
                    // same contract as memories (P1-13): "删了能查、误删能回滚" now holds
                    // for BOTH forgetting faces (DESIGN §5.2).
                    this.db.prepare('INSERT INTO forget_deleted_episodes(ts, episode_id, session_id, summary, topic, tools_used, reason) VALUES (?,?,?,?,?,?,?)').run(now, ep.id, ep.session_id, ep.summary, ep.topic, ep.tools_used ?? null, 'episode-observation-passed');
                    this.hardDeleteEpisode(ep.id);
                    deletedEpi += 1;
                    decisions.push(`ep-delete:${ep.id}`);
                }
            }
            // P1-14: bound audit-table growth (the "库只增不减" problem restated on the
            // audit tables). Delete-snapshots are kept longer — they're the rollback window.
            this.db.prepare('DELETE FROM failure_memories WHERE corrected_at < ?').run(now - 180 * DAY_MS);
            this.db.prepare('DELETE FROM forget_runs WHERE ts < ?').run(now - 180 * DAY_MS);
            this.db.prepare('DELETE FROM refine_runs WHERE ts < ?').run(now - 180 * DAY_MS);
            this.db.prepare('DELETE FROM forget_deleted WHERE ts < ?').run(now - 365 * DAY_MS);
            this.db.prepare('DELETE FROM forget_deleted_episodes WHERE ts < ?').run(now - 365 * DAY_MS);
            const applied = demoted + archivedMem + deletedMem + archivedEpi + deletedEpi;
            const sha = createHash('sha256').update(decisions.join('\n')).digest('hex').slice(0, 16);
            const run = this.db.prepare('INSERT INTO forget_runs(ts, candidate_sha, decisions, applied, status) VALUES (?,?,?,?,?)')
                .run(now, sha, JSON.stringify(decisions), applied, 'ok');
            this.db.exec('COMMIT');
            return { demoted, archivedMem, deletedMem, archivedEpi, deletedEpi, runId: Number(run.lastInsertRowid), status: 'ok' };
        }
        catch (err) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { /* noop */ }
            throw err;
        }
    }
}
function inferKind(content) {
    const c = content.toLowerCase();
    if (/(偏好|喜欢|prefer|风格|ppt|颜色|字体)/.test(c))
        return 'preference';
    if (/(环境|配置|命令|安装|路径|端?口|host|url)/.test(c))
        return 'env';
    if (/(教训|注意|坑|别|以后|avoid|pitfall)/.test(c))
        return 'lesson';
    if (/(决定|结论|方案|决策|选用|采用|使用)/.test(c))
        return 'decision';
    return 'general';
}
