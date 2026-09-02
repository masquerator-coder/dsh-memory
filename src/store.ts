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
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ApplyResult,
  BudgetUsage,
  Episode,
  EpisodeHit,
  Epistemic,
  ForgetDays,
  Importance,
  Kind,
  Layer,
  LessonDraft,
  MemoryBudget,
  MemoryEntry,
  MemoryOp,
  RecallHit,
  Tier,
} from './types.js'
import { DAY_MS, heatOf, resolveForgetDays, shouldArchive, shouldDelete, shouldDemote } from './heat.js'
import { contentSimilarity, isNearDupCandidate, isLowQuality, qualityScore } from './quality.js'
import { DDL, rebuildFts } from './schema.js'

export const DEFAULT_BUDGET: MemoryBudget = { tier0: 900, user: 400, memory: 500 }

/** Fallback group label for entries the model did not tag. */
const DEFAULT_TOPIC = 'general'
/** Topic labels are UI/index hints, not content — keep them short. */
const TOPIC_MAX = 40
/** Minimum length (chars) both sides must meet before an id-less `replace` will
 * substring-match. Prevents a tiny fragment from silently overwriting a whole
 * entry (P0-3). */
const MIN_REPLACE_FRAGMENT = 8
/** Near-duplicate similarity threshold (contentSimilarity, 0=disjoint 1=id).
 *  Writing a fact at or above this closeness to an existing active row merges
 *  into that canonical row instead of inserting a duplicate (P2-dedup, 2026).
 *  Kept conservative (0.85) so genuinely distinct facts sharing a long phrase
 *  are not auto-merged; ambiguous cases go to replacement/待审, never auto. */
export const SIM_DUP = 0.85
/** Cap on facts offered per L2 cluster — a giant untagged 'general' bucket must
 * not be dumped whole into the LLM prompt (P2-29). */
const MAX_FACTS_PER_CLUSTER = 25

/** Episode recency half-life (days) for recall ranking. */
const EPISODE_RECENCY_DAYS = 90

export function resolveDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Hard-content id: identical facts collapse instead of duplicating. */
export function contentId(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** Escape SQL LIKE wildcards for use with an `ESCAPE '\'` clause. */
function escapeLike(s: string): string {
  return String(s).replace(/[\\%_]/g, '\\$&')
}

export interface ListFilter {
  layer?: Layer
  tier?: Tier
  kind?: Kind
  includeArchived?: boolean
  includeLowQuality?: boolean
}

/** Result of {@link MemoryStore.exportSnapshot} or an import validation pass. */
export interface BackupStats {
  /** Snapshot file size in bytes. */
  size: number
  /** Active (non-archived) memory rows in the snapshot. */
  memories: number
  /** Active (non-archived) episode rows in the snapshot. */
  episodes: number
  /** Monotonic ms timestamp captured when the snapshot was taken. */
  exportedAt: number
}

export interface RecallOpts {
  topK?: number
  includeArchived?: boolean
  includeLowQuality?: boolean
  epistemicWeighting?: boolean
}

export interface ForgetResult {
  demoted: number
  archivedMem: number
  deletedMem: number
  archivedEpi: number
  deletedEpi: number
  runId: number
  status: string
}

function epiMult(epistemic: string): number {
  if (epistemic === 'observed') return 1
  if (epistemic === 'inferred') return 0.9
  return 0.8
}

export class MemoryStore {
  readonly dir: string
  readonly dbPath: string
  readonly budget: MemoryBudget
  readonly windowDays: number
  readonly forgetDays: ForgetDays
  private db: DatabaseSync
  // P3-1: these statements are (re)assigned by prepareStatements() — not readonly
  // so a backup import can hot-swap the connection (see replaceWithBackup).
  private upsertMemStmt!: ReturnType<DatabaseSync['prepare']>
  private upsertFtsStmt!: ReturnType<DatabaseSync['prepare']>
  private upsertEpiStmt!: ReturnType<DatabaseSync['prepare']>
  private upsertEpiFtsStmt!: ReturnType<DatabaseSync['prepare']>
  private rowidStmt!: ReturnType<DatabaseSync['prepare']>
  private epiRowidStmt!: ReturnType<DatabaseSync['prepare']>
  // P3-11 (review 2026-08-30): `get()` re-prepared its statement on every call
  // (23.6µs vs 6.7µs pre-compiled, 3.5x) and sits on the recall/touchAccess
  // hot path — prepare once here.
  private getMemStmt!: ReturnType<DatabaseSync['prepare']>
  /** P3-1 (review 2026-08-31): prepared-statement cache keyed by SQL text —
   *  `list()`, the exact-content dedup lookups, and the forget/audit updates
   *  re-prepared on every call (the same 3.5x gap P3-11 fixed for `get()`),
   *  and they sit on the add / enforceBudget / forgetRun hot paths. Clause-
   *  combination SQL (list/recall) yields a bounded, structural key set. */
  private readonly stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>()

  constructor(home = resolveDshHome(), budget: MemoryBudget = DEFAULT_BUDGET, windowDays = 30, forgetDays: ForgetDays = resolveForgetDays()) {
    this.dir = join(home, 'memory')
    mkdirSync(this.dir, { recursive: true })
    this.dbPath = join(this.dir, 'memory.db')
    this.budget = budget
    this.windowDays = windowDays
    this.forgetDays = forgetDays
    // P1-15: node:sqlite is experimental before Node 24 and unavailable before
    // 22.5. Give a clear error (vs. a raw crash) and rely on `engines`/ability.
    try {
      this.db = new DatabaseSync(this.dbPath)
    } catch (err) {
      throw new Error(
        `dsh-memory: cannot open SQLite store — node:sqlite requires Node >=22.5 (found ${process.version}). ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA busy_timeout=3000')
    this.db.exec(DDL)
    rebuildFts(this.db)

    this.prepareStatements()
  }

  /**
   * (Re-)prepare every hot-path prepared statement. Called from the constructor
   * and from {@link replaceWithBackup} after the underlying DB connection is
   * swapped — the 7 named statements are the only ones the store keeps across
   * calls; everything else goes through the {@link stmtCache} (cleared on swap).
   */
  private prepareStatements(): void {
    this.upsertMemStmt = this.stmt(`
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
    `)
    // FTS5 virtual tables reject UPSERT — use INSERT OR REPLACE keyed by the
    // content table's implicit rowid (id TEXT PRIMARY KEY still has one).
    this.upsertFtsStmt = this.stmt('INSERT OR REPLACE INTO mem_fts(rowid, content, topic) VALUES (?,?,?)')
    this.rowidStmt = this.stmt('SELECT rowid AS r FROM memories WHERE id = ?')

    this.upsertEpiStmt = this.stmt(`
      INSERT INTO episodes
        (id, session_id, ts, summary, tools_used, topic, extracted, archived, archived_at, created)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        session_id=excluded.session_id, ts=excluded.ts, summary=excluded.summary,
        tools_used=excluded.tools_used, topic=excluded.topic, extracted=excluded.extracted,
        archived=excluded.archived, archived_at=excluded.archived_at, created=excluded.created
    `)
    this.upsertEpiFtsStmt = this.stmt('INSERT OR REPLACE INTO ep_fts(rowid, summary, topic) VALUES (?,?,?)')
    this.epiRowidStmt = this.stmt('SELECT rowid AS r FROM episodes WHERE id = ?')
    this.getMemStmt = this.stmt('SELECT * FROM memories WHERE id = ?')
  }

  close(): void {
    this.db.close()
  }

  // ---- backup / restore (SQLite-level whole-DB snapshot) ------------------

  /**
   * Export a consistent, self-contained snapshot of the ENTIRE store (all
   * tables: memories, episodes, FTS, forget/refine/lesson audit trails) to
   * `destPath` using SQLite's `VACUUM INTO`. The output is a single,
   * WAL-independent .db file (safe even while the live store is in WAL mode),
   * restorable later via {@link replaceWithBackup}. Zero dependency.
   */
  exportSnapshot(destPath: string): BackupStats {
    // Single-quote SQL string literal escaping; forward-slash the path so it
    // parses cleanly on every platform (backslashes are not SQL escapes).
    const abs = destPath.replace(/\\/g, '/').replace(/'/g, "''")
    this.db.exec(`VACUUM INTO '${abs}'`)
    const st = statSync(destPath)
    return {
      size: st.size,
      memories: this.count(),
      episodes: this.episodeCount(),
      exportedAt: Date.now(),
    }
  }

  /**
   * Validate that `path` is a readable SQLite file carrying the dsh-memory
   * schema (memories + episodes tables). Used to refuse a bogus/unrelated file
   * BEFORE touching the live store during {@link replaceWithBackup}. Read-only
   * open — never mutates the candidate file.
   */
  static validateBackup(
    path: string,
  ): { ok: true; memories: number; episodes: number } | { ok: false; error: string } {
    let db: DatabaseSync
    try {
      db = new DatabaseSync(path, { readOnly: true })
    } catch (e) {
      return { ok: false, error: `不是可读取的 SQLite 文件：${e instanceof Error ? e.message : String(e)}` }
    }
    try {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
      const names = new Set(rows.map((r) => r.name))
      if (!names.has('memories') || !names.has('episodes')) {
        return { ok: false, error: '不是 dsh-memory 备份（缺少 memories / episodes 表）' }
      }
      const mc = db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }
      const ec = db.prepare('SELECT COUNT(*) AS c FROM episodes').get() as { c: number }
      return { ok: true, memories: Number(mc.c), episodes: Number(ec.c) }
    } catch (e) {
      return { ok: false, error: `备份结构读取失败：${e instanceof Error ? e.message : String(e)}` }
    } finally {
      try { db.close() } catch { /* already closed */ }
    }
  }

  /**
   * Restore the store from a dsh-memory backup .db file (`srcPath`), replacing
   * ALL current data. Validates the candidate first (refuses to clobber on a
   * bogus file), then hot-swaps the underlying connection so every already-held
   * closure (routes, tools, refine/l0 passes, systemPrompt sections) keeps
   * working against the restored data — only the store's internal db handle
   * changes. A safety snapshot of the pre-import state is written to
   * `memory.db.pre-import.bak` so a regretful import can be undone manually.
   */
  replaceWithBackup(srcPath: string): { memories: number; episodes: number } {
    const check = MemoryStore.validateBackup(srcPath)
    if (!check.ok) throw new Error(`无法导入：${check.error}`)
    // 1. Safety net: snapshot the current state before clobbering it.
    const bakPath = join(this.dir, 'memory.db.pre-import.bak')
    try {
      const bak = bakPath.replace(/\\/g, '/').replace(/'/g, "''")
      this.db.exec(`VACUUM INTO '${bak}'`)
    } catch (e) {
      // Non-fatal: import proceeds, but surface so the user knows rollback is unavailable.
      console.warn('[dsh-memory] pre-import safety backup failed:', e instanceof Error ? e.message : e)
    }
    // 2. Close the live connection (SQLite checkpoints WAL on close) and drop
    //    any stale -wal/-shm so the swap opens clean.
    this.db.close()
    rmSync(this.dbPath + '-wal', { force: true })
    rmSync(this.dbPath + '-shm', { force: true })
    const reopen = (): void => {
      this.db = new DatabaseSync(this.dbPath)
      this.db.exec('PRAGMA journal_mode=WAL')
      this.db.exec('PRAGMA busy_timeout=3000')
      // CREATE TABLE IF NOT EXISTS is a no-op on an already-schema'd backup;
      // keeps the restore resilient to minor flag changes without rebuilding FTS.
      this.db.exec(DDL)
      rebuildFts(this.db)
      this.stmtCache.clear()
      this.prepareStatements()
    }
    // 3. Overwrite the live file with the backup and reopen.
    try {
      copyFileSync(srcPath, this.dbPath)
      reopen()
    } catch (e) {
      // The live connection is already closed — don't leave the store broken.
      // The pre-import backup is a complete (VACUUM INTO) stand-in for memory.db,
      // so restore it and reopen before rethrowing.
      try {
        rmSync(this.dbPath + '-wal', { force: true })
        rmSync(this.dbPath + '-shm', { force: true })
        copyFileSync(bakPath, this.dbPath)
        reopen()
      } catch {
        /* restore failed too — the store stays closed; data survives in .bak */
      }
      throw e
    }
    return { memories: check.memories, episodes: check.episodes }
  }

  /** P3-1: cached prepare — see {@link stmtCache}. */
  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let s = this.stmtCache.get(sql)
    if (s === undefined) {
      s = this.db.prepare(sql)
      this.stmtCache.set(sql, s)
    }
    return s
  }

  // ---- row mapping ---------------------------------------------------------

  private rowToEntry(r: Record<string, unknown>): MemoryEntry {
    return {
      id: String(r.id),
      layer: r.layer as Layer,
      kind: r.kind as Kind,
      tier: Number(r.tier) as Tier,
      topic: String(r.topic),
      content: String(r.content),
      importance: Number(r.importance) as Importance,
      quality: Number(r.quality),
      epistemic: r.epistemic as Epistemic,
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
    }
  }

  private rowToEpisode(r: Record<string, unknown>): Episode {
    return {
      id: String(r.id),
      session_id: String(r.session_id),
      ts: Number(r.ts),
      summary: String(r.summary),
      tools_used: r.tools_used ? String(r.tools_used) : undefined,
      topic: String(r.topic),
      // P3-13: three-state (0/1/2) — boolean coercion made degraded (2)
      // indistinguishable from untouched (0) on read-back.
      extracted: Number(r.extracted) as 0 | 1 | 2,
      archived: Number(r.archived) === 1,
      archived_at: r.archived_at ? Number(r.archived_at) : undefined,
      created: Number(r.created),
    }
  }

  // ---- reads (memories) ----------------------------------------------------

  get(id: string): MemoryEntry | undefined {
    const r = this.getMemStmt.get(id) as Record<string, unknown> | undefined
    return r ? this.rowToEntry(r) : undefined
  }

  list(filter: ListFilter = {}): MemoryEntry[] {
    const clauses: string[] = ['1=1']
    const params: (string | number)[] = []
    if (filter.layer) { clauses.push('layer = ?'); params.push(filter.layer) }
    if (filter.tier !== undefined) { clauses.push('tier = ?'); params.push(filter.tier) }
    if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind) }
    if (filter.includeArchived !== true) clauses.push('archived = 0')
    if (filter.includeLowQuality === false) clauses.push('low_quality = 0')
    const rows = this.stmt(`SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY updated DESC, rowid DESC`).all(...params)
    return rows.map(r => this.rowToEntry(r as Record<string, unknown>))
  }

  activeEntries(): MemoryEntry[] {
    return this.list({ includeArchived: false, includeLowQuality: true })
  }

  count(): number {
    const r = this.stmt('SELECT COUNT(*) AS c FROM memories WHERE archived = 0').get() as { c: number }
    return Number(r.c)
  }

  /** Active (non-archived) episode count, without loading rows (P2-25). */
  episodeCount(): number {
    const r = this.stmt('SELECT COUNT(*) AS c FROM episodes WHERE archived = 0').get() as { c: number }
    return Number(r.c)
  }

  /** Tier-0 (injectable, non-archived, non-low-quality) usage.
   *  R4 (review 2026-08-30): SQL aggregate — the old version loaded and JS-mapped
   *  every tier-0 row on each call (batch/tools both call this per write). */
  usage(): BudgetUsage {
    const rows = this.stmt(
      'SELECT layer AS l, SUM(LENGTH(content)) AS n FROM memories WHERE tier = 0 AND archived = 0 AND low_quality = 0 GROUP BY layer',
    ).all() as { l: string; n: number | null }[]
    let user = 0
    let memory = 0
    for (const r of rows) {
      if (r.l === 'user') user += Number(r.n ?? 0)
      else memory += Number(r.n ?? 0)
    }
    const total = user + memory
    return { user, memory, total, pct: this.budget.tier0 > 0 ? Math.round((total / this.budget.tier0) * 100) : 0 }
  }

  topicsIndex(): { topic: string; count: number }[] {
    const rows = this.stmt(
      'SELECT topic, COUNT(*) AS c FROM memories WHERE tier = 1 AND archived = 0 GROUP BY topic ORDER BY c DESC',
    ).all() as { topic: string; c: number }[]
    return rows.map(r => ({ topic: String(r.topic), count: Number(r.c) }))
  }

  /** Bounded dedup candidate set (P2-16): only rows sharing the head of `content`
   *  are compared for the duplicate penalty, so add/replace cost stops scaling with
   *  library size. (Content-equality dedup — P0-2 — is exact and separate.)
   *  R4 (review 2026-08-30): the old `LIKE '%head%'` had a leading wildcard and
   *  full-scanned every row; this prefix-anchored range rides idx_mem_content. */
  private nearCandidates(content: string, cap = 8): MemoryEntry[] {
    const slice = content.slice(0, 12).trim()
    if (!slice) return []
    const rows = this.stmt(
      "SELECT * FROM memories WHERE archived = 0 AND content >= ? AND content < ? LIMIT ?",
    ).all(slice, `${slice}\uffff`, cap) as Record<string, unknown>[]
    return rows.map(r => this.rowToEntry(r))
  }

  /** Return the single canonical active row already encoding the same fact as
   *  `content` (contentSimilarity >= SIM_DUP, same layer), or null.
   *
   *  P2-dedup (2026-08-31): the shared near-duplicate primitive. Used by
   *  `add` (merge instead of insert), the identity-write gate, and cross-cluster
   *  L2 (periodic re-dedup) — one place decides "is this a new fact or a
   *  rewording of an existing one", so those paths can't disagree.
   *
   *  Candidate generation is bounded via mem_fts MATCH on word tokens (the same
   *  pattern recall uses), so RE-WORDED duplicates surface on shared tokens —
   *  unlike the prefix-12 scan in nearCandidates, which an entry whose opening
   *  was rewritten slips past. Exact-content always wins (authoritative). */
  findCanonical(content: string, layer?: Layer): MemoryEntry | null {
    const c = (content ?? '').trim()
    if (!c) return null
    // Exact content is the source of truth — rejoins even a row whose id has
    // drifted after a `replace`, and reactivates an archived fact (R1 contract).
    const exact = this.stmt('SELECT * FROM memories WHERE content = ? LIMIT 1').get(c) as Record<string, unknown> | undefined
    if (exact) {
      const e = this.rowToEntry(exact)
      if (!layer || e.layer === layer) return e
    }
    // Near-duplicate: full bounded scan of ACTIVE rows with the STRICT
    // SIM_DUP gate (write-time auto-merge must be conservative — never collapse
    // two genuinely distinct facts that happen to share a long phrase). A
    // personal dsh memory store is small (hundreds of rows), so an O(n) scan is
    // microseconds and is far more reliable than FTS phrase-matching, which
    // missed reworded entries containing path-like tokens (c:\users\...). Keep
    // the highest-importance, earliest-created winner as canonical.
    let best: MemoryEntry | null = null
    for (const e of this.list({ includeArchived: false, includeLowQuality: false })) {
      if (layer && e.layer !== layer) continue
      if (contentSimilarity(e.content, c) < SIM_DUP) continue
      if (!best || e.importance > best.importance || (e.importance === best.importance && e.created < best.created)) best = e
    }
    return best
  }

  /** All ACTIVE rows near-duplicate to `content` (same layer; exact match always
   *  first). Uses the LOOSE `isNearDupCandidate` gate because it feeds candidate
   *  GROUPING (cross-topic L2 fusion + one-shot migration) where a downstream
   *  judge decides the real merge — not the write-time auto-merge, which stays
   *  strict (SIM_DUP) in findCanonical. O(n) over active rows (personal scale). */
  nearDuplicates(content: string, layer?: Layer): MemoryEntry[] {
    const c = (content ?? '').trim()
    if (!c) return []
    const out: MemoryEntry[] = []
    const seen = new Set<string>()
    const exact = this.stmt('SELECT * FROM memories WHERE content = ? LIMIT 1').get(c) as Record<string, unknown> | undefined
    if (exact) {
      const e = this.rowToEntry(exact)
      if (!e.archived && (!layer || e.layer === layer)) { out.push(e); seen.add(e.id) }
    }
    for (const e of this.list({ includeArchived: false, includeLowQuality: false })) {
      if (seen.has(e.id)) continue
      if (layer && e.layer !== layer) continue
      if (isNearDupCandidate(e.content, c)) { out.push(e); seen.add(e.id) }
    }
    return out
  }

  /** Cross-topic near-duplicate groups for L2 (P2-dedup, 2026-08-31).
   *  `semanticClusters()` groups strictly by the `topic` string, so a fact
   *  reworded into a different topic (approval-policy / approval policy /
   *  审批策略) lands in separate clusters and is never co-adjudicated. This
   *  pass assembles connected components of near-duplicates (BFS following
   *  nearDuplicates) across topic boundaries, so L2 can merge/drop them.
   *  Bounded: stops after `limit` groups. */
  crossTopicNearDupGroups(
    opts: { min?: number; limit?: number } = {},
  ): { seedId: string; topic: string; facts: { id: string; content: string; kind?: Kind; importance?: Importance; updated: number }[] }[] {
    const min = opts.min ?? 2
    const limit = opts.limit ?? 8
    const active = this.list({ includeArchived: false, includeLowQuality: false })
    const consumed = new Set<string>()
    const groups: { seedId: string; topic: string; facts: { id: string; content: string; kind?: Kind; importance?: Importance; updated: number }[] }[] = []
    for (const probe of active) {
      if (consumed.has(probe.id)) continue
      const members: MemoryEntry[] = [probe]
      consumed.add(probe.id)
      const stack: MemoryEntry[] = [probe]
      while (stack.length > 0) {
        const cur = stack.pop()!
        for (const nd of this.nearDuplicates(cur.content, cur.layer)) {
          if (consumed.has(nd.id)) continue
          consumed.add(nd.id); members.push(nd); stack.push(nd)
        }
      }
      if (members.length >= min) {
        const seed = [...members].sort((a, b) => b.importance - a.importance || a.created - b.created)[0]
        groups.push({
          seedId: seed.id,
          topic: seed.topic,
          facts: members.map(m => ({ id: m.id, content: m.content, kind: m.kind, importance: m.importance, updated: m.updated }))
            .sort((a, b) => a.importance - b.importance || a.updated - b.updated).slice(0, MAX_FACTS_PER_CLUSTER),
        })
        if (groups.length >= limit) break
      }
    }
    return groups
  }

  // ---- writes (memories) ---------------------------------------------------

  private autoTier(layer: Layer, importance: Importance, quality: number, kind: Kind, low: boolean): Tier {
    if (low) return 1
    if (layer === 'user') return 0
    if (importance >= 4 && quality >= 60 && (kind === 'preference' || kind === 'env')) return 0
    return 1
  }

  private writeMemory(id: string, fields: Omit<MemoryEntry, 'id'>): void {
    this.upsertMemStmt.run(
      id, fields.layer, fields.kind, fields.tier, fields.topic, fields.content, fields.importance,
      fields.quality, fields.epistemic, fields.heat, fields.created, fields.updated, fields.last_accessed,
      fields.archived ? 1 : 0, fields.low_quality ? 1 : 0, fields.window_freq, fields.window_start,
      fields.archived_at ?? null, fields.session_id ?? null,
    )
    const rowid = Number(this.rowidStmt.get(id)!.r)
    this.upsertFtsStmt.run(rowid, fields.content, fields.topic)
  }

  private hardDeleteMemory(id: string): void {
    const row = this.rowidStmt.get(id) as { r: number } | undefined
    const r = this.stmt('DELETE FROM memories WHERE id = ?').run(id)
    if (r.changes > 0 && row) this.stmt('DELETE FROM mem_fts WHERE rowid = ?').run(Number(row.r))
    // P3-15 (review 2026-08-30): cascade the correction trail — the memory row is
    // physically gone, so leaving failure_memories rows only extends other
    // entries' observation windows with references to a dead id. (remove force
    // and forgetRun's hard-delete both land here.)
    if (r.changes > 0) this.stmt('DELETE FROM failure_memories WHERE memory_id = ?').run(id)
  }

  private applyOne(op: MemoryOp, now: number): { ok: boolean; error?: string; lowQualityId?: string } {
    if (op.action === 'add' || op.action === 'replace') {
      const content = (op.content ?? '').trim()
      if (!content) return { ok: false, error: 'content is required' }
      const layer: Layer = op.layer ?? 'memory'
      const kind: Kind = op.kind ?? inferKind(content)
      const importance: Importance = op.importance ?? 3
      const epistemic: Epistemic = op.epistemic ?? 'observed'
      // P2-3 (review 2026-08-31): no `op.topic === ''` special case — an
      // explicit empty string and other blank forms both fall back to
      // DEFAULT_TOPIC, so no '' clustering bucket can appear in topicsIndex.
      const topic = (op.topic ?? '').trim().slice(0, TOPIC_MAX) || DEFAULT_TOPIC

      if (op.action === 'add') {
        // P0-2: dedup on exact content (source of truth), not merely the
        // content-hash id. `contentId(content)` can go stale after a `replace`
        // (which keeps the row's original id), so a row might hold this content
        // under a different id — re-adding that content must update it, never
        // insert a duplicate. Keep the matched row's id stable (external handle).
        const cid = contentId(content)
        let existing = this.get(cid)
        if (existing && existing.content !== content) existing = undefined // cid row belongs to a different fact (drift) — don't trust it
        // G4 (2026-09-01, re-fix 2026-09-02): a cid hit whose CONTENT is identical
        // but whose LAYER differs must not be merged into that row. The 09-01 guard
        // only set `existing = undefined`, but the write then fell back to the
        // DETERMINISTIC content-hash `id`, so the ON CONFLICT(id) upsert still
        // silently flipped the row's layer (user → memory drops the immortality /
        // tier-0 protection; memory → user grants it unmerited). The existing row
        // is the authoritative identity of that content — preserve it untouched.
        // An explicit layer change belongs on replace(id, { layer }).
        if (existing && existing.layer !== layer) {
          return { ok: true }
        }
        if (!existing) {
          // P2-dedup (2026-08-31): the exact-content lookup below was only able
          // to catch byte-identical duplicates (P0-2). findCanonical extends it
          // one step further — a RE-WORDED near-duplicate (contentSimilarity >=
          // SIM_DUP) also merges into the canonical row instead of inserting a
          // new one, which is what let approval-policy / workspace / file-policy
          // bloat into 6-9 near-identical rows. Exact-content still wins first.
          existing = this.findCanonical(content, layer) ?? undefined
        }
        // G4 case-2 (2026-09-02): no same-layer canonical, but an EXACT same-content
        // row exists under a drifted id (e.g. after a replace) with a different
        // layer — never duplicate or clobber it either. Preserve the authoritative
        // row; an explicit layer change belongs on replace(id, { layer }).
        if (!existing) {
          const exAny = this.stmt('SELECT * FROM memories WHERE content = ? LIMIT 1').get(content)
          if (exAny) {
            const ex = this.rowToEntry(exAny)
            if (!ex.archived && ex.layer !== layer) {
              return { ok: true }
            }
          }
        }
        const id = existing ? existing.id : cid
        const quality = existing ? existing.quality : qualityScore(content, this.nearCandidates(content))
        const low = isLowQuality(quality)
        const tier = existing ? (low ? 1 : (op.tier ?? existing.tier)) : (op.tier ?? this.autoTier(layer, importance, quality, kind, low))
        if (existing) {
          // P2-1 (review 2026-08-31): merging into a canonical row must NOT
          // clobber its metadata with op defaults — a near-worded re-add without
          // an explicit importance used to reset it to 3, piercing the
          // importance>=5 never-hard-delete immunity. Unspecified fields keep
          // the existing values (same semantics as the replace path, P2-37).
          // S1 (2026-09-01, re-fix 2026-09-02): a near-duplicate merge must never
          // let a SHORTER added fragment silently truncate a longer stored entry.
          // The 09-01 gate (`new >= existing * 0.5`) was vacuous for the merge
          // path: findCanonical only merges at contentSimilarity >= SIM_DUP (0.85)
          // within a length-ratio window <= 2, so a shorter merged fact is ALWAYS
          // >= 85% of the existing entry — it cleared the 50% gate every time and
          // the `recordFailure` branch below was dead code, so the richer existing
          // content was overwritten with no audit trail. Now we only replace stored
          // content when the new fact is at least as LONG (an extension); a shorter
          // add keeps the richer existing content and records the drop in the
          // failure_memories trail (recoverable, no silent loss).
          const shouldOverwriteContent = op.authoritative === true || content.length >= existing.content.length
          const finalContent = shouldOverwriteContent ? content : existing.content
          if (!shouldOverwriteContent && content !== existing.content) {
            this.recordFailure(existing.id, existing.content, content)
          }
          this.writeMemory(id, {
            layer,
            kind: op.kind ?? existing.kind,
            tier,
            topic: op.topic !== undefined && op.topic.trim() !== '' ? topic : existing.topic,
            content: finalContent,
            importance: op.importance ?? existing.importance,
            quality,
            epistemic: op.epistemic ?? existing.epistemic,
            heat: heatOf(existing, this.forgetDays), created: existing.created, updated: now,
            // R1 (review 2026-08-30): re-adding content that matches an ARCHIVED
            // entry reactivates it — the tool says "已记入", so the fact must become
            // visible/recallable again. Keeping the old archived=1 silently broke
            // the write contract (recorded but never retrievable).
            last_accessed: existing.last_accessed, archived: false, low_quality: low,
            window_freq: existing.window_freq, window_start: existing.window_start,
            archived_at: undefined, session_id: op.sessionId ?? existing.session_id,
          })
        } else {
          this.writeMemory(id, {
            layer, kind, tier, topic, content, importance, quality, epistemic,
            heat: 1, created: now, updated: now, last_accessed: now, archived: false, low_quality: low,
            window_freq: 0, window_start: 0, session_id: op.sessionId,
          })
        }
        // P2-9: surface low_quality at the write boundary — "已记入" must not
        // hide "recorded but excluded from default recall/injection".
        return low ? { ok: true, lowQualityId: id } : { ok: true }
      }

      // replace
      let target = op.id ? this.get(op.id) : undefined
      if (!target && op.id) return { ok: false, error: `no entry with id ${op.id}` }
      if (!target) {
        // P0-3: never silently match by a tiny fragment — a 1-char content could
        // overwrite a whole entry with a fragment. Only substring-match when BOTH
        // sides are ≥ MIN_REPLACE_FRAGMENT, else refuse and demand an explicit id.
        // G5 (2026-09-01): require unambiguous match — collect all candidates and
        // reject if more than one matches the fragment.
        if (content.length >= MIN_REPLACE_FRAGMENT) {
          const matches = this.activeEntries().filter(e => e.content.length >= MIN_REPLACE_FRAGMENT && (e.content.includes(content) || content.includes(e.content)))
          if (matches.length === 1) {
            target = matches[0]
          } else if (matches.length > 1) {
            return { ok: false, error: `fragment matches ${matches.length} entries; pass id for an exact replace` }
          }
        }
        if (!target) return { ok: false, error: `replace without id needs an unambiguous ≥${MIN_REPLACE_FRAGMENT}-char fragment to target; pass id for an exact replace` }
      }
      if (!target) return { ok: false, error: 'no entry matched for replace' }
      const oldContent = target.content
      const quality = qualityScore(content, this.nearCandidates(content))
      const low = isLowQuality(quality)
      const tier = low ? 1 : (op.tier ?? target.tier)

      if (content !== oldContent) {
        this.recordFailure(target.id, oldContent, content)
      }
      // P2-37: replace must keep the entry's topic unless the caller explicitly
      // provides one — the shared `topic` default above (DEFAULT_TOPIC) used to
      // clobber it to 'general', scattering same-topic L2 clusters.
      const newTopic = op.topic === undefined || op.topic === null || String(op.topic).trim() === ''
        ? target.topic
        : String(op.topic).trim().slice(0, TOPIC_MAX) || DEFAULT_TOPIC
      this.writeMemory(target.id, {
        layer, kind, tier, topic: newTopic, content, importance, quality, epistemic,
        heat: heatOf(target, this.forgetDays), created: target.created, updated: now,
        last_accessed: target.last_accessed, archived: target.archived, low_quality: low,
        window_freq: target.window_freq, window_start: target.window_start,
        archived_at: target.archived_at, session_id: op.sessionId ?? target.session_id,
      })
      // P2-9: same low-quality surfacing on replace.
      return low ? { ok: true, lowQualityId: target.id } : { ok: true }
    }

    if (op.action === 'remove') {
      const target = op.id ? this.get(op.id) : undefined
      if (!target) return { ok: false, error: `no entry with id ${op.id}` }
      if (op.force) {
        this.hardDeleteMemory(target.id)
      } else {
        this.stmt('UPDATE memories SET archived = 1, archived_at = ?, updated = ? WHERE id = ?').run(now, now, target.id)
      }
      return { ok: true }
    }

    return { ok: false, error: `unsupported action ${String(op.action)}` }
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
  private enforceBudget(now: number): { demoted: string[]; over: boolean } {
    const demoted: string[] = []
    const done = new Set<string>()
    // Single load (P2-19): all tier-0 residents once; importance >= 5 is the
    // protected resident core (never demoted) but still counts toward usage.
    const all = this.list({ tier: 0, includeArchived: false, includeLowQuality: false })
    const demotable = all.filter(e => e.importance < 5)
      .sort((a, b) => heatOf(a, this.forgetDays, now) - heatOf(b, this.forgetDays, now) || a.importance - b.importance)
    const totalOf = (pred: (e: MemoryEntry) => boolean): number => {
      let n = 0
      for (const e of all) { if (!done.has(e.id) && pred(e)) n += e.content.length }
      return n
    }
    const memUse = (): number => totalOf(e => e.layer !== 'user')
    const usrUse = (): number => totalOf(e => e.layer === 'user')
    const demote = (e: MemoryEntry): void => {
      this.stmt('UPDATE memories SET tier = 1 WHERE id = ?').run(e.id)
      done.add(e.id)
      demoted.push(e.id)
    }
    const squeeze = (pred: (e: MemoryEntry) => boolean, over: () => boolean): void => {
      for (const e of demotable) {
        if (done.has(e.id) || !pred(e) || !over()) continue
        demote(e)
      }
    }
    squeeze(e => e.layer !== 'user', () => memUse() > this.budget.memory)
    squeeze(e => e.layer === 'user', () => usrUse() > this.budget.user)
    squeeze(() => true, () => memUse() + usrUse() > this.budget.tier0)
    const over = memUse() > this.budget.memory || usrUse() > this.budget.user || (memUse() + usrUse()) > this.budget.tier0
    return { demoted, over }
  }

  /** Model-facing write batch; lands globally and immediately.
   *  R5 (review 2026-08-30): SAVEPOINT instead of BEGIN/COMMIT — safe both
   *  standalone and nested inside a caller-held transaction (same pattern as
   *  writeEpisode, P1-12). The old BEGIN IMMEDIATE threw "cannot start a
   *  transaction within a transaction" when composed. */
  batch(ops: MemoryOp[], sessionId?: string): ApplyResult {
    const now = Date.now()
    const applied: MemoryOp[] = []
    const rejected: { op: MemoryOp; reason: string }[] = []
    // P2-9: ids written/updated with low_quality=1, surfaced to the tool layer.
    const lowQualityIds: string[] = []
    this.db.exec('SAVEPOINT dsh_batch')
    try {
      for (const op of ops) {
        if (op.action === 'list') continue
        const mapped: MemoryOp = sessionId ? { ...op, sessionId } : op
        const res = this.applyOne(mapped, now)
        if (res.ok) {
          applied.push(mapped)
          if (res.lowQualityId) lowQualityIds.push(res.lowQualityId)
        }
        else rejected.push({ op: mapped, reason: res.error! })
      }
      const { demoted, over } = this.enforceBudget(now)
      if (over) {
        this.db.exec('ROLLBACK TO dsh_batch')
        this.db.exec('RELEASE dsh_batch')
        // R4: compute only when actually reported — after rollback the state is
        // exactly the pre-batch snapshot this return describes.
        const before = this.activeEntries()
        const usage = this.usage()
        return { applied: [], rejected: ops.map(o => ({ op: o, reason: 'memory budget exceeded' })), entries: before, overflowed: true, demoted: [], lowQuality: [], usage }
      }
      this.db.exec('RELEASE dsh_batch')
      // R4 (review 2026-08-30): `entries` is only consumed on the overflow path
      // (tools.ts) — evaluate lazily once on first access so a plain add does
      // not pay a full active-set load per batch. Same value when read.
      const store = this
      let entriesCache: MemoryEntry[] | undefined
      const res: ApplyResult = {
        applied, rejected, overflowed: false, demoted, lowQuality: lowQualityIds, usage: this.usage(),
        get entries(): MemoryEntry[] { return (entriesCache ??= store.activeEntries()) },
      }
      return res
    } catch (err) {
      try { this.db.exec('ROLLBACK TO dsh_batch') } catch { /* noop */ }
      try { this.db.exec('RELEASE dsh_batch') } catch { /* noop */ }
      throw err
    }
  }

  // ---- recall (memories) ---------------------------------------------------

  /** Refresh last_accessed + sliding-window frequency for recalled entries. */
  private touchAccess(ids: string[]): void {
    const now = Date.now()
    const windowMs = this.windowDays * DAY_MS
    const upd = this.stmt('UPDATE memories SET last_accessed = ?, window_freq = ?, window_start = ? WHERE id = ?')
    for (const id of ids) {
      const e = this.get(id)
      if (!e) continue
      let freq: number
      let start: number
      if (e.window_start === 0 || now - e.window_start > windowMs) {
        freq = 1
        start = now
      } else {
        freq = e.window_freq + 1
        start = e.window_start
      }
      upd.run(now, freq, start, id)
    }
  }

  recall(query: string, opts: RecallOpts = {}): RecallHit[] {
    const topK = opts.topK ?? 8
    const weighting = opts.epistemicWeighting ?? true
    const now = Date.now()
    const qLower = query.toLowerCase()
    const keywords = query.split(/[\s,，。;；、]+/).map(k => k.toLowerCase()).filter(Boolean)

    // P4-1 (review 2026-09-01): CJK fairness fix. The FTS5 tables use the
    // unicode61 tokenizer, which has NO CJK word segmentation — a pure-Chinese
    // query never reaches the FTS +6 branch, so matched Chinese memories only
    // scored +4/+1 via the LIKE substring layer while English (or
    // English-containing) memories won +6/token from FTS. Observed effect:
    // mixed queries systematically ranked English entries above equally
    // relevant Chinese ones. Fix: when the query carries CJK, a candidate
    // hitting ALL CJK keywords earns the same base weight as an FTS hit; a
    // strict-majority hit earns a partial bump. Pure-ASCII queries untouched.
    const CJK_RE = /[\u3400-\u9fff]/
    const hasCJK = CJK_RE.test(query)
    const cjkKw = keywords.filter(k => CJK_RE.test(k))

    // P2-17: candidate pre-filter in SQL (FTS ∪ any-substring) so recall does
    // NOT load + scan the whole library in JS. NB (P3-9, review 2026-08-31):
    // the LIKE '%term%' leading-wildcard branches still scan inside SQLite's C
    // layer (no index) — bounded by personal-scale row counts, not by JS cost.
    // base>0 iff the row is FTS-hit OR its content/topic contains the raw query
    // OR any keyword — all expressed below.
    const seen = new Set<string>()
    const candidates: MemoryEntry[] = []
    const push = (e: MemoryEntry | undefined): void => {
      if (!e || seen.has(e.id)) return
      seen.add(e.id)
      candidates.push(e)
    }
    // FTS hit rows fetched one-shot (P1-5): the old version collected ids then
    // re-fetched each row via get() — two queries per hit.
    const ftsIds = new Set<string>()
    try {
      const q = query.split(/\s+/).filter(Boolean).map(t => `"${t.replaceAll('"', '""')}"`).join(' ')
      if (q) {
        for (const row of this.stmt('SELECT * FROM memories WHERE rowid IN (SELECT rowid FROM mem_fts WHERE mem_fts MATCH ?)').all(q) as Record<string, unknown>[]) {
          const e = this.rowToEntry(row)
          ftsIds.add(e.id)
          if (opts.includeArchived !== true && e.archived) continue
          if (opts.includeLowQuality !== true && e.low_quality) continue
          push(e)
        }
      }
    } catch { /* MATCH lex error → substring layer covers */ }
    // Substring candidates via SQL LIKE over content/topic.
    const baseClauses: string[] = ['1=1']
    if (opts.includeArchived !== true) baseClauses.push('archived = 0')
    if (opts.includeLowQuality !== true) baseClauses.push('low_quality = 0')
    const like = "(\"content\" LIKE ? ESCAPE '\\' OR \"topic\" LIKE ? ESCAPE '\\')"
    const ors: string[] = []
    const params: string[] = []
    const addTerm = (s: string): void => {
      const e = escapeLike(s)
      ors.push(like)
      params.push(`%${e}%`, `%${e}%`)
    }
    addTerm(qLower)
    for (const k of keywords) addTerm(k)
    const sql = `SELECT * FROM memories WHERE ${baseClauses.join(' AND ')} AND (${ors.join(' OR ')})`
    for (const r of this.stmt(sql).all(...params) as Record<string, unknown>[]) push(this.rowToEntry(r))

    if (candidates.length === 0) return []

    const scored: RecallHit[] = []
    for (const e of candidates) {
      let base = 0
      if (ftsIds.has(e.id)) base += 6
      const text = `${e.topic}\n${e.content}`.toLowerCase()
      if (text.includes(qLower)) base += 4
      for (const k of keywords) if (text.includes(k)) base += 1
      // P4-1: CJK fairness — compensate the missing FTS weight (see header).
      // ALL CJK query terms covered = as relevant as an FTS hit; a strict-majority
      // coverage gets a bump.
      if (hasCJK && !ftsIds.has(e.id) && cjkKw.length > 0) {
        const hit = cjkKw.filter(k => text.includes(k)).length
        if (hit === cjkKw.length) base += 6
        else if (hit >= Math.max(1, Math.ceil(cjkKw.length / 2))) base += 3
      }
      if (base === 0) continue
      const heat = heatOf(e, this.forgetDays, now)
      const score = base * (weighting ? epiMult(e.epistemic) : 1) * (0.5 + 0.5 * heat)
      scored.push({ entry: e, score })
    }
    scored.sort((a, b) => b.score - a.score || b.entry.updated - a.entry.updated || (a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0))
    const top = scored.slice(0, topK)
    if (top.length > 0) this.touchAccess(top.map(h => h.entry.id))
    return top
  }

  // ---- episodes ------------------------------------------------------------

  writeEpisode(id: string, fields: Omit<Episode, 'id'>): void {
    // P1-12: episode row + its FTS row must land atomically, or a crash between
    // them leaves episodes/ep_fts inconsistent (recall silently drops rows).
    // SAVEPOINT (not BEGIN) so this is safe both standalone and when the caller
    // is already inside a transaction (e.g. an enclosing batch).
    this.db.exec('SAVEPOINT ep_write')
    try {
      this.upsertEpiStmt.run(
        id, fields.session_id, fields.ts, fields.summary, fields.tools_used ?? null,
        fields.topic, fields.extracted, fields.archived ? 1 : 0, fields.archived_at ?? null,
        fields.created,
      )
      const rowid = Number(this.epiRowidStmt.get(id)!.r)
      this.upsertEpiFtsStmt.run(rowid, fields.summary, fields.topic)
      this.db.exec('RELEASE ep_write')
    } catch (err) {
      try { this.db.exec('ROLLBACK TO ep_write') } catch { /* noop */ }
      try { this.db.exec('RELEASE ep_write') } catch { /* noop */ }
      throw err
    }
  }

  addEpisode(fields: { sessionId: string; summary: string; toolsUsed?: string; topic?: string }): Episode {
    const now = Date.now()
    const id = contentId(`${fields.sessionId}:${now}`)
    const ep: Episode = {
      id,
      session_id: fields.sessionId,
      ts: now,
      summary: fields.summary.trim(),
      tools_used: fields.toolsUsed,
      topic: (fields.topic ?? '').trim().slice(0, TOPIC_MAX) || DEFAULT_TOPIC,
      extracted: 0,
      archived: false,
      created: now,
    }
    this.writeEpisode(id, ep)
    return ep
  }

  getEpisode(id: string): Episode | undefined {
    const r = this.stmt('SELECT * FROM episodes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? this.rowToEpisode(r) : undefined
  }

  /** M5: freshest episode of a session (for session-level LLM consolidation to
   *  overwrite the last pending rule summary, avoiding per-turn episode pileup). */
  lastEpisodeForSession(sessionId: string): Episode | undefined {
    const r = this.stmt(
      'SELECT * FROM episodes WHERE session_id = ? AND archived = 0 ORDER BY ts DESC, rowid DESC LIMIT 1',
    ).get(sessionId) as Record<string, unknown> | undefined
    return r ? this.rowToEpisode(r) : undefined
  }

  /** M5: overwrite an episode's summary + timestamp (keeps FTS in sync; used by
   *  the idle session-consolidation pass to upgrade a rule snapshot to a full
   *  session-level LLM summary without duplicating rows). */
  replaceEpisodeSummary(id: string, summary: string): boolean {
    const cur = this.getEpisode(id)
    if (!cur) return false
    this.writeEpisode(id, { ...cur, summary: summary.trim(), ts: Date.now() })
    return true
  }

  listEpisodes(filter: { includeArchived?: boolean } = {}): Episode[] {
    const clauses: string[] = ['1=1']
    if (filter.includeArchived !== true) clauses.push('archived = 0')
    const rows = this.stmt(`SELECT * FROM episodes WHERE ${clauses.join(' AND ')} ORDER BY ts DESC, rowid DESC`).all()
    return rows.map(r => this.rowToEpisode(r as Record<string, unknown>))
  }

  /** P1-5 (review 2026-08-30): candidate pre-filter pushed into SQL — FTS hits
   *  fetched one-shot, substring candidates via LIKE over summary/topic. The old
   *  version loaded EVERY active episode into JS before scoring (4000 rows →
   *  8.6ms/call, strictly linear; the semantic recall path is O(hits) at 0.05ms).
   *  Scoring itself is unchanged — same FTS/substring/keyword base + recency. */
  recallEpisodes(query: string, opts: { topK?: number } = {}): EpisodeHit[] {
    const topK = opts.topK ?? 8
    const seen = new Set<string>()
    const candidates: Episode[] = []
    const push = (ep: Episode | undefined): void => {
      if (!ep || seen.has(ep.id)) return
      seen.add(ep.id)
      candidates.push(ep)
    }

    const ftsIds = new Set<string>()
    try {
      const q = query.split(/\s+/).filter(Boolean).map(t => `"${t.replaceAll('"', '""')}"`).join(' ')
      if (q) {
        for (const row of this.stmt('SELECT * FROM episodes WHERE rowid IN (SELECT rowid FROM ep_fts WHERE ep_fts MATCH ?)').all(q) as Record<string, unknown>[]) {
          const ep = this.rowToEpisode(row)
          ftsIds.add(ep.id)
          if (ep.archived) continue
          push(ep)
        }
      }
    } catch { /* MATCH lex error → substring layer covers */ }

    // Substring candidates via SQL LIKE over summary/topic (only active rows).
    const qLower = query.toLowerCase()
    const keywords = query.split(/[\s,，。;；、]+/).map(k => k.toLowerCase()).filter(Boolean)
    // P4-1: CJK fairness + noise gate for episodic recall (mirrors recall()).
    const CJK_RE = /[\u3400-\u9fff]/
    const hasCJK = CJK_RE.test(query)
    const cjkKw = keywords.filter(k => CJK_RE.test(k))
    const like = "(\"summary\" LIKE ? ESCAPE '\\' OR \"topic\" LIKE ? ESCAPE '\\')"
    const ors: string[] = []
    const params: string[] = []
    const addTerm = (s: string): void => {
      const e = escapeLike(s)
      ors.push(like)
      params.push(`%${e}%`, `%${e}%`)
    }
    addTerm(qLower)
    for (const k of keywords) addTerm(k)
    const sql = `SELECT * FROM episodes WHERE archived = 0 AND (${ors.join(' OR ')})`
    for (const r of this.stmt(sql).all(...params) as Record<string, unknown>[]) push(this.rowToEpisode(r))

    if (candidates.length === 0) return []

    const scored: EpisodeHit[] = []
    const now = Date.now()
    for (const ep of candidates) {
      let base = 0
      if (ftsIds.has(ep.id)) base += 6
      const text = `${ep.topic}\n${ep.summary}`.toLowerCase()
      if (text.includes(qLower)) base += 4
      for (const k of keywords) if (text.includes(k)) base += 1
      // P4-1: CJK fairness + noise gate (mirrors recall()).
      if (hasCJK && !ftsIds.has(ep.id) && cjkKw.length > 0) {
        const hit = cjkKw.filter(k => text.includes(k)).length
        if (hit === cjkKw.length) base += 6
        else if (hit >= Math.max(1, Math.ceil(cjkKw.length / 2))) base += 3
      }
      if (base === 0) continue
      const recency = Math.exp(-(now - ep.ts) / (EPISODE_RECENCY_DAYS * DAY_MS))
      const score = base * (0.5 + 0.5 * recency)
      scored.push({ episode: ep, score })
    }
    scored.sort((a, b) => b.score - a.score || b.episode.ts - a.episode.ts || (a.episode.id < b.episode.id ? 1 : a.episode.id > b.episode.id ? -1 : 0))
    return scored.slice(0, topK)
  }

  private hardDeleteEpisode(id: string): void {
    // P1-12: delete episode + FTS atomically; SAVEPOINT stays safe when the
    // caller (forgetRun) already holds a transaction.
    this.db.exec('SAVEPOINT ep_delete')
    try {
      const row = this.epiRowidStmt.get(id) as { r: number } | undefined
      const r = this.stmt('DELETE FROM episodes WHERE id = ?').run(id)
      if (r.changes > 0 && row) this.stmt('DELETE FROM ep_fts WHERE rowid = ?').run(Number(row.r))
      this.db.exec('RELEASE ep_delete')
    } catch (err) {
      try { this.db.exec('ROLLBACK TO ep_delete') } catch { /* noop */ }
      try { this.db.exec('RELEASE ep_delete') } catch { /* noop */ }
      throw err
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
  listEpisodesForRefine(opts: { retryDegraded?: boolean; limit?: number } = {}): Episode[] {
    const status = opts.retryDegraded ? 'extracted IN (0, 2)' : 'extracted = 0'
    const limit = opts.limit && opts.limit > 0 ? `LIMIT ${Math.floor(opts.limit)}` : ''
    const rows = this.stmt(
      `SELECT * FROM episodes WHERE archived = 0 AND ${status} ORDER BY ts ASC ${limit}`,
    ).all()
    return rows.map(r => this.rowToEpisode(r as Record<string, unknown>))
  }

  /** Record L1 processing state on an episode (0 untouched → 1 extracted → 2 degraded-skip). */
  markEpisodeExtracted(id: string, status: 1 | 2): void {
    this.stmt('UPDATE episodes SET extracted = ? WHERE id = ?').run(status, id)
  }

  /** Semantic clusters (same topic, ≥ min members) as L2 merge candidates.
   *  M7 (2026-08-30): when `incremental` is set, a cluster whose topic has been
   *  LLM-audited before (l2_refined) AND has no member updated since is skipped —
   *  the stable-cluster zero-LLM case. Facts carry `updated` so the caller can
   *  judge change without a second query. */
  semanticClusters(
    opts: { min?: number; limit?: number; includeLowQuality?: boolean; incremental?: boolean } = {},
  ): { seedId: string; topic: string; facts: { id: string; content: string; kind?: Kind; importance?: Importance; updated: number }[] }[] {
    const min = opts.min ?? 2
    const byTopic = new Map<string, { id: string; content: string; kind?: Kind; importance?: Importance; updated: number }[]>()
    for (const e of this.list({ includeArchived: false, includeLowQuality: opts.includeLowQuality === true })) {
      const arr = byTopic.get(e.topic) ?? []
      arr.push({ id: e.id, content: e.content, kind: e.kind, importance: e.importance, updated: e.updated })
      byTopic.set(e.topic, arr)
    }
    const out: { seedId: string; topic: string; facts: { id: string; content: string; kind?: Kind; importance?: Importance; updated: number }[] }[] = []
    for (const [topic, facts] of byTopic) {
      if (facts.length < min) continue
      if (opts.incremental) {
        const refinedAt = this.l2RefinedTs(topic)
        if (refinedAt !== undefined && facts.every(f => f.updated <= refinedAt)) continue
      }
      out.push({ seedId: facts[0].id, topic, facts: facts.slice(0, MAX_FACTS_PER_CLUSTER) })
    }
    out.sort((a, b) => b.facts.length - a.facts.length)
    return (opts.limit && opts.limit > 0) ? out.slice(0, opts.limit) : out
  }

  /** Append one L1/L2 LLM-decision audit row (degraded runs record null route). */
  writeRefineRun(fields: {
    level: number
    sourceId?: string
    promptSha?: string
    route?: string
    decisions: string
    status: string
  }): number {
    const r = this.stmt(
      'INSERT INTO refine_runs(ts, level, source_id, prompt_sha, llm_route, decisions, status) VALUES (?,?,?,?,?,?,?)',
    ).run(Date.now(), fields.level, fields.sourceId ?? null, fields.promptSha ?? null, fields.route ?? null,
      fields.decisions, fields.status)
    return Number(r.lastInsertRowid)
  }

/** Prior audit rows for one refine source — bounded-retry accounting for L1
    *  episodes whose facts were rejected (e.g. tier-0 budget overflow). Counts
    *  refine_runs rows with status 'ok' or 'ok-noop' (degraded/error not counted);
    *  the 180-day audit pruning also bounds this counter. */
  refineAttemptCount(sourceId: string): number {
    const r = this.stmt("SELECT COUNT(*) AS c FROM refine_runs WHERE source_id = ? AND status IN ('ok','ok-noop')").get(sourceId) as { c: number }
    return Number(r.c)
  }

  /** M7: last LLM-audit timestamp for a topic cluster (undefined = never audited → audit). */
  l2RefinedTs(topic: string): number | undefined {
    const r = this.stmt('SELECT refined_at AS r FROM l2_refined WHERE topic = ?').get(topic) as { r: number } | undefined
    return r ? Number(r.r) : undefined
  }

  /** M7: record that a topic cluster was LLM-audited at `ts` (idempotent upsert). */
  upsertL2Refined(topic: string, ts = Date.now()): void {
    this.stmt(
      'INSERT INTO l2_refined(topic, refined_at) VALUES (?, ?) ON CONFLICT(topic) DO UPDATE SET refined_at = excluded.refined_at',
    ).run(topic, ts)
  }

  // ---- correction trail ----------------------------------------------------

  /** Optional hook fired after a lesson draft is (re)written, so the host can
   *  fire-and-forget an instant LLM judgement (lessonInstantJudge) WITHOUT
   *  coupling the synchronous store to the async LLM seam. Default unset. */
  onLessonDraft?: (draftId: number) => void

  recordFailure(memoryId: string, oldContent: string, newContent: string): void {
    this.stmt('INSERT INTO failure_memories(memory_id, old_content, new_content, corrected_at) VALUES (?,?,?,?)')
      .run(memoryId, oldContent, newContent, Date.now())
    // ZERO-LLM base of the lesson pipeline (DESIGN §2.3): dual-write a staged
    // lesson draft. Aggregates repeated corrections of the same memory into one
    // draft (draft_count), never stacks one draft per correction.
    this.upsertLessonDraft(memoryId, oldContent, newContent)
  }

  /** Design §2.3: upsert one staged lesson draft per corrected memory (aggregate
   *  frequent corrections into a single `draft` row by bumping draft_count). The
   *  `lesson` field starts as a pure-rule template so even a no-LLM run has a
   *  fallen-back lesson text. Zero LLM, synchronous, never throws. */
  private upsertLessonDraft(memoryId: string, oldContent: string, newContent: string): void {
    const now = Date.now()
    try {
      const existing = this.stmt(
        "SELECT id, draft_count FROM lesson_drafts WHERE memory_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1",
      ).get(memoryId) as { id: number; draft_count: number } | undefined
      if (existing) {
        this.stmt('UPDATE lesson_drafts SET draft_count = ?, new_content = ?, drafted_at = ? WHERE id = ?')
          .run(existing.draft_count + 1, newContent, now, existing.id)
        this.fireLessonDraft(existing.id)
        return
      }
      const lesson = `判断曾被纠正：原记“${oldContent}”，更正为“${newContent}”。`
      const r = this.stmt(
        "INSERT INTO lesson_drafts(memory_id, topic, old_content, new_content, lesson, source, status, draft_count, drafted_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(memoryId, 'general', oldContent, newContent, lesson, 'replace', 'draft', 1, now)
      this.fireLessonDraft(Number(r.lastInsertRowid))
    } catch {
      // The zero-LLM base must never break the correction write. Audit already
      // went to failure_memories above; a failed draft is dropped silently.
    }
  }

  private fireLessonDraft(draftId: number): void {
    if (!this.onLessonDraft) return
    try { this.onLessonDraft(draftId) } catch { /* observer must not break writes */ }
  }

  /** List staged lesson drafts (oldest first). */
  listLessonDrafts(opts: { status?: 'draft' | 'promoted' | 'dropped'; limit?: number } = {}): LessonDraft[] {
    let sql = 'SELECT * FROM lesson_drafts'
    const params: Array<string | number | null> = []
    if (opts.status) { sql += ' WHERE status = ?'; params.push(opts.status) }
    sql += ' ORDER BY drafted_at ASC'
    const lim = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit as number)) : 0
    if (lim > 0) sql += ` LIMIT ${lim}`
    const rows = this.stmt(sql).all(...params) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: Number(r.id),
      memory_id: String(r.memory_id),
      topic: String(r.topic ?? 'general'),
      old_content: r.old_content == null ? null : String(r.old_content),
      new_content: r.new_content == null ? null : String(r.new_content),
      lesson: String(r.lesson ?? ''),
      source: String(r.source ?? 'replace'),
      status: String(r.status) as LessonDraft['status'],
      draft_count: Number(r.draft_count ?? 1),
      drafted_at: Number(r.drafted_at),
    }))
  }

  getLessonDraft(id: number): LessonDraft | undefined {
    const r = this.stmt('SELECT * FROM lesson_drafts WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!r) return undefined
    return {
      id: Number(r.id),
      memory_id: String(r.memory_id),
      topic: String(r.topic ?? 'general'),
      old_content: r.old_content == null ? null : String(r.old_content),
      new_content: r.new_content == null ? null : String(r.new_content),
      lesson: String(r.lesson ?? ''),
      source: String(r.source ?? 'replace'),
      status: String(r.status) as LessonDraft['status'],
      draft_count: Number(r.draft_count ?? 1),
      drafted_at: Number(r.drafted_at),
    }
  }

  markLessonDraftStatus(id: number, status: 'promoted' | 'dropped'): void {
    this.stmt('UPDATE lesson_drafts SET status = ? WHERE id = ?').run(status, id)
  }

  failureTrail(): { memoryId: string; oldContent: string; newContent: string; correctedAt: number }[] {
    const rows = this.stmt('SELECT memory_id, old_content, new_content, corrected_at FROM failure_memories').all() as Record<string, unknown>[]
    return rows.map(r => ({
      memoryId: String(r.memory_id),
      oldContent: String(r.old_content ?? ''),
      newContent: String(r.new_content ?? ''),
      correctedAt: Number(r.corrected_at),
    }))
  }

  /** P3-2 (review 2026-08-31): shared pending-correction predicate — this was
   *  duplicated verbatim between hasPendingCorrection and forgetRun's inline
   *  closure (P2-18). One place decides "is this content still referenced by a
   *  correction trail (corrected-once → extend life)". */
  private pendingCorrectionIn(trail: { oldContent: string }[], content: string): boolean {
    for (const f of trail) {
      const oldC = f.oldContent.trim()
      if (!oldC) continue
      if (contentSimilarity(oldC, content) >= 0.5 || content.includes(oldC) || oldC.includes(content)) return true
    }
    return false
  }

  /** True when a failure trail still references this content (corrected-once → extend life). */
  hasPendingCorrection(content: string): boolean {
    return this.pendingCorrectionIn(this.failureTrail(), content)
  }

  // ---- active forgetting (three-level ladder + two faces) ------------------

  forgetRun(cfg: {
    forgetDays?: Partial<ForgetDays>
    // P3-12 (review 2026-08-30): the old `windowDays` param was declared but
    // never read — the effective window is the constructor's this.windowDays.
    // Removed instead of silently keeping a dead knob.
    episodeRetentionDays?: number
    observeDays?: number
  }, now = Date.now()): ForgetResult {
    const forgetDays = resolveForgetDays(cfg.forgetDays)
    const observeDays = cfg.observeDays ?? 30
    const retentionDays = cfg.episodeRetentionDays ?? 180
    const decisions: string[] = []
    let demoted = 0
    let archivedMem = 0
    let deletedMem = 0
    let archivedEpi = 0
    let deletedEpi = 0

    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 1. demote cold tier-0 memories
      for (const e of this.list({ tier: 0, includeArchived: false, includeLowQuality: true })) {
        if (shouldDemote(e, forgetDays, now)) {
          this.stmt('UPDATE memories SET tier = 1, updated = ? WHERE id = ?').run(now, e.id)
          demoted += 1
          decisions.push(`demote:${e.id}`)
        }
      }
      // 2. archive cold memories
      for (const e of this.activeEntries()) {
        if (shouldArchive(e, forgetDays, now)) {
          this.stmt('UPDATE memories SET archived = 1, archived_at = ?, updated = ? WHERE id = ?').run(now, now, e.id)
          archivedMem += 1
          decisions.push(`archive:${e.id}`)
        }
      }
      // P2-18: load the correction trail once outside the delete loop — it was
      // re-querying the whole failure_memories table for every candidate entry.
      // P3-2: the predicate itself is the shared pendingCorrectionIn helper.
      const trail = this.failureTrail()
      const pendingCorrection = (content: string): boolean => this.pendingCorrectionIn(trail, content)
      // 3. hard-delete archived memories past observation
      for (const e of this.list({ includeArchived: true, includeLowQuality: true })) {
        if (!e.archived) continue
        if (shouldDelete(e, observeDays, pendingCorrection(e.content), now)) {
          // P1-13: snapshot BEFORE physical delete — content is unrecoverable after
          // hardDeleteMemory, so this row is the only durable evidence for rollback.
          this.stmt(
            'INSERT INTO forget_deleted(ts, memory_id, content, topic, importance, quality, heat, reason) VALUES (?,?,?,?,?,?,?,?)',
          ).run(now, e.id, e.content, e.topic, e.importance, e.quality, heatOf(e, this.forgetDays, now), 'observed-observation-passed')
          this.hardDeleteMemory(e.id)
          deletedMem += 1
          decisions.push(`delete:${e.id}`)
        }
      }
      // 4. archive old episodes (time-driven)
      for (const ep of this.listEpisodes({ includeArchived: false })) {
        if (now - ep.ts > retentionDays * DAY_MS) {
          this.stmt('UPDATE episodes SET archived = 1, archived_at = ? WHERE id = ?').run(now, ep.id)
          archivedEpi += 1
          decisions.push(`ep-archive:${ep.id}`)
        }
      }
      // 5. hard-delete archived episodes past observation
      for (const ep of this.listEpisodes({ includeArchived: true })) {
        if (!ep.archived || ep.archived_at === undefined) continue
        if (now - ep.archived_at > observeDays * DAY_MS) {
          // R7 (review 2026-08-30, P2-10): snapshot BEFORE physical delete —
          // same contract as memories (P1-13): "删了能查、误删能回滚" now holds
          // for BOTH forgetting faces (DESIGN §5.2).
          this.stmt(
            'INSERT INTO forget_deleted_episodes(ts, episode_id, session_id, summary, topic, tools_used, reason) VALUES (?,?,?,?,?,?,?)',
          ).run(now, ep.id, ep.session_id, ep.summary, ep.topic, ep.tools_used ?? null, 'episode-observation-passed')
          this.hardDeleteEpisode(ep.id)
          deletedEpi += 1
          decisions.push(`ep-delete:${ep.id}`)
        }
      }

      // P1-14: bound audit-table growth (the "库只增不减" problem restated on the
      // audit tables). Delete-snapshots are kept longer — they're the rollback window.
      this.stmt('DELETE FROM failure_memories WHERE corrected_at < ?').run(now - 180 * DAY_MS)
      this.stmt('DELETE FROM forget_runs WHERE ts < ?').run(now - 180 * DAY_MS)
      this.stmt('DELETE FROM refine_runs WHERE ts < ?').run(now - 180 * DAY_MS)
      this.stmt('DELETE FROM forget_deleted WHERE ts < ?').run(now - 365 * DAY_MS)
      this.stmt('DELETE FROM forget_deleted_episodes WHERE ts < ?').run(now - 365 * DAY_MS)

      const applied = demoted + archivedMem + deletedMem + archivedEpi + deletedEpi
      const sha = createHash('sha256').update(decisions.join('\n')).digest('hex').slice(0, 16)
      const run = this.stmt('INSERT INTO forget_runs(ts, candidate_sha, decisions, applied, status) VALUES (?,?,?,?,?)')
        .run(now, sha, JSON.stringify(decisions), applied, 'ok')
      this.db.exec('COMMIT')
      return { demoted, archivedMem, deletedMem, archivedEpi, deletedEpi, runId: Number(run.lastInsertRowid), status: 'ok' }
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* noop */ }
      throw err
    }
  }
}

function inferKind(content: string): Kind {
  const c = content.toLowerCase()
  if (/(偏好|喜欢|prefer|风格|ppt|颜色|字体)/.test(c)) return 'preference'
  if (/(环境|配置|命令|安装|路径|端?口|host|url)/.test(c)) return 'env'
  if (/(教训|注意|坑|别|以后|avoid|pitfall)/.test(c)) return 'lesson'
  if (/(决定|结论|方案|决策|选用|采用|使用)/.test(c)) return 'decision'
  return 'general'
}
