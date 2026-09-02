import type { ApplyResult, BudgetUsage, Episode, EpisodeHit, ForgetDays, Importance, Kind, Layer, MemoryBudget, MemoryEntry, MemoryOp, RecallHit, Tier } from './types.js';
export declare const DEFAULT_BUDGET: MemoryBudget;
/** Near-duplicate similarity threshold (contentSimilarity, 0=disjoint 1=id).
 *  Writing a fact at or above this closeness to an existing active row merges
 *  into that canonical row instead of inserting a duplicate (P2-dedup, 2026).
 *  Kept conservative (0.85) so genuinely distinct facts sharing a long phrase
 *  are not auto-merged; ambiguous cases go to replacement/待审, never auto. */
export declare const SIM_DUP = 0.85;
export declare function resolveDshHome(): string;
/** Hard-content id: identical facts collapse instead of duplicating. */
export declare function contentId(content: string): string;
export interface ListFilter {
    layer?: Layer;
    tier?: Tier;
    kind?: Kind;
    includeArchived?: boolean;
    includeLowQuality?: boolean;
}
export interface RecallOpts {
    topK?: number;
    includeArchived?: boolean;
    includeLowQuality?: boolean;
    epistemicWeighting?: boolean;
}
export interface ForgetResult {
    demoted: number;
    archivedMem: number;
    deletedMem: number;
    archivedEpi: number;
    deletedEpi: number;
    runId: number;
    status: string;
}
export declare class MemoryStore {
    readonly dir: string;
    readonly dbPath: string;
    readonly budget: MemoryBudget;
    readonly windowDays: number;
    readonly forgetDays: ForgetDays;
    private db;
    private readonly upsertMemStmt;
    private readonly upsertFtsStmt;
    private readonly upsertEpiStmt;
    private readonly upsertEpiFtsStmt;
    private readonly rowidStmt;
    private readonly epiRowidStmt;
    private readonly getMemStmt;
    /** P3-1 (review 2026-08-31): prepared-statement cache keyed by SQL text —
     *  `list()`, the exact-content dedup lookups, and the forget/audit updates
     *  re-prepared on every call (the same 3.5x gap P3-11 fixed for `get()`),
     *  and they sit on the add / enforceBudget / forgetRun hot paths. Clause-
     *  combination SQL (list/recall) yields a bounded, structural key set. */
    private readonly stmtCache;
    constructor(home?: string, budget?: MemoryBudget, windowDays?: number, forgetDays?: ForgetDays);
    close(): void;
    /** P3-1: cached prepare — see {@link stmtCache}. */
    private stmt;
    private rowToEntry;
    private rowToEpisode;
    get(id: string): MemoryEntry | undefined;
    list(filter?: ListFilter): MemoryEntry[];
    activeEntries(): MemoryEntry[];
    count(): number;
    /** Active (non-archived) episode count, without loading rows (P2-25). */
    episodeCount(): number;
    /** Tier-0 (injectable, non-archived, non-low-quality) usage.
     *  R4 (review 2026-08-30): SQL aggregate — the old version loaded and JS-mapped
     *  every tier-0 row on each call (batch/tools both call this per write). */
    usage(): BudgetUsage;
    topicsIndex(): {
        topic: string;
        count: number;
    }[];
    /** Bounded dedup candidate set (P2-16): only rows sharing the head of `content`
     *  are compared for the duplicate penalty, so add/replace cost stops scaling with
     *  library size. (Content-equality dedup — P0-2 — is exact and separate.)
     *  R4 (review 2026-08-30): the old `LIKE '%head%'` had a leading wildcard and
     *  full-scanned every row; this prefix-anchored range rides idx_mem_content. */
    private nearCandidates;
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
    findCanonical(content: string, layer?: Layer): MemoryEntry | null;
    /** All ACTIVE rows near-duplicate to `content` (same layer; exact match always
     *  first). Uses the LOOSE `isNearDupCandidate` gate because it feeds candidate
     *  GROUPING (cross-topic L2 fusion + one-shot migration) where a downstream
     *  judge decides the real merge — not the write-time auto-merge, which stays
     *  strict (SIM_DUP) in findCanonical. O(n) over active rows (personal scale). */
    nearDuplicates(content: string, layer?: Layer): MemoryEntry[];
    /** Cross-topic near-duplicate groups for L2 (P2-dedup, 2026-08-31).
     *  `semanticClusters()` groups strictly by the `topic` string, so a fact
     *  reworded into a different topic (approval-policy / approval policy /
     *  审批策略) lands in separate clusters and is never co-adjudicated. This
     *  pass assembles connected components of near-duplicates (BFS following
     *  nearDuplicates) across topic boundaries, so L2 can merge/drop them.
     *  Bounded: stops after `limit` groups. */
    crossTopicNearDupGroups(opts?: {
        min?: number;
        limit?: number;
    }): {
        seedId: string;
        topic: string;
        facts: {
            id: string;
            content: string;
            kind?: Kind;
            importance?: Importance;
            updated: number;
        }[];
    }[];
    private autoTier;
    private writeMemory;
    private hardDeleteMemory;
    private applyOne;
    /**
     * Make the tier-0 injection budget fit by demoting the coldest eligible entries.
     * Three budgets are enforced (P1-7): the memory layer, the user layer (user is
     * immortal — never deleted, but CAN be pushed out of the resident injected set
     * under pressure), and the whole-section cap. `importance >= 5` is the protected
     * resident core and is never demoted — so if those alone overflow a bucket, the
     * batch is rejected (overflow becomes truly reachable, P1-8). Returns the ids
     * demoted and whether budget still exceeds after demotion (P1-9 surfaces them).
     */
    private enforceBudget;
    /** Model-facing write batch; lands globally and immediately.
     *  R5 (review 2026-08-30): SAVEPOINT instead of BEGIN/COMMIT — safe both
     *  standalone and nested inside a caller-held transaction (same pattern as
     *  writeEpisode, P1-12). The old BEGIN IMMEDIATE threw "cannot start a
     *  transaction within a transaction" when composed. */
    batch(ops: MemoryOp[], sessionId?: string): ApplyResult;
    /** Refresh last_accessed + sliding-window frequency for recalled entries. */
    private touchAccess;
    recall(query: string, opts?: RecallOpts): RecallHit[];
    writeEpisode(id: string, fields: Omit<Episode, 'id'>): void;
    addEpisode(fields: {
        sessionId: string;
        summary: string;
        toolsUsed?: string;
        topic?: string;
    }): Episode;
    getEpisode(id: string): Episode | undefined;
    /** M5: freshest episode of a session (for session-level LLM consolidation to
     *  overwrite the last pending rule summary, avoiding per-turn episode pileup). */
    lastEpisodeForSession(sessionId: string): Episode | undefined;
    /** M5: overwrite an episode's summary + timestamp (keeps FTS in sync; used by
     *  the idle session-consolidation pass to upgrade a rule snapshot to a full
     *  session-level LLM summary without duplicating rows). */
    replaceEpisodeSummary(id: string, summary: string): boolean;
    listEpisodes(filter?: {
        includeArchived?: boolean;
    }): Episode[];
    /** P1-5 (review 2026-08-30): candidate pre-filter pushed into SQL — FTS hits
     *  fetched one-shot, substring candidates via LIKE over summary/topic. The old
     *  version loaded EVERY active episode into JS before scoring (4000 rows →
     *  8.6ms/call, strictly linear; the semantic recall path is O(hits) at 0.05ms).
     *  Scoring itself is unchanged — same FTS/substring/keyword base + recency. */
    recallEpisodes(query: string, opts?: {
        topK?: number;
    }): EpisodeHit[];
    private hardDeleteEpisode;
    /**
     * Episodes awaiting L1 extraction, oldest first. `extracted = 0` (untouched)
     * are the pending queue; `== 2` (degraded) are retried only when
     * retryDegraded is set — so a hot LLM outage degrades cleanly without
     * hammering the route every pass. (P3-14: comment previously stated the
     * exact opposite of what the SQL does.)
     */
    listEpisodesForRefine(opts?: {
        retryDegraded?: boolean;
        limit?: number;
    }): Episode[];
    /** Record L1 processing state on an episode (0 untouched → 1 extracted → 2 degraded-skip). */
    markEpisodeExtracted(id: string, status: 1 | 2): void;
    /** Semantic clusters (same topic, ≥ min members) as L2 merge candidates.
     *  M7 (2026-08-30): when `incremental` is set, a cluster whose topic has been
     *  LLM-audited before (l2_refined) AND has no member updated since is skipped —
     *  the stable-cluster zero-LLM case. Facts carry `updated` so the caller can
     *  judge change without a second query. */
    semanticClusters(opts?: {
        min?: number;
        limit?: number;
        includeLowQuality?: boolean;
        incremental?: boolean;
    }): {
        seedId: string;
        topic: string;
        facts: {
            id: string;
            content: string;
            kind?: Kind;
            importance?: Importance;
            updated: number;
        }[];
    }[];
    /** Append one L1/L2 LLM-decision audit row (degraded runs record null route). */
    writeRefineRun(fields: {
        level: number;
        sourceId?: string;
        promptSha?: string;
        route?: string;
        decisions: string;
        status: string;
    }): number;
    /** Prior audit rows for one refine source — bounded-retry accounting for L1
        *  episodes whose facts were rejected (e.g. tier-0 budget overflow). Counts
        *  refine_runs rows with status 'ok' or 'ok-noop' (degraded/error not counted);
        *  the 180-day audit pruning also bounds this counter. */
    refineAttemptCount(sourceId: string): number;
    /** M7: last LLM-audit timestamp for a topic cluster (undefined = never audited → audit). */
    l2RefinedTs(topic: string): number | undefined;
    /** M7: record that a topic cluster was LLM-audited at `ts` (idempotent upsert). */
    upsertL2Refined(topic: string, ts?: number): void;
    recordFailure(memoryId: string, oldContent: string, newContent: string): void;
    failureTrail(): {
        memoryId: string;
        oldContent: string;
        newContent: string;
        correctedAt: number;
    }[];
    /** P3-2 (review 2026-08-31): shared pending-correction predicate — this was
     *  duplicated verbatim between hasPendingCorrection and forgetRun's inline
     *  closure (P2-18). One place decides "is this content still referenced by a
     *  correction trail (corrected-once → extend life)". */
    private pendingCorrectionIn;
    /** True when a failure trail still references this content (corrected-once → extend life). */
    hasPendingCorrection(content: string): boolean;
    forgetRun(cfg: {
        forgetDays?: Partial<ForgetDays>;
        episodeRetentionDays?: number;
        observeDays?: number;
    }, now?: number): ForgetResult;
}
