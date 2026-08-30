import type { ApplyResult, BudgetUsage, Episode, EpisodeHit, ForgetDays, Importance, Kind, Layer, MemoryBudget, MemoryEntry, MemoryOp, RecallHit, Tier } from './types.js';
export declare const DEFAULT_BUDGET: MemoryBudget;
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
    constructor(home?: string, budget?: MemoryBudget, windowDays?: number, forgetDays?: ForgetDays);
    close(): void;
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
     *  refine_runs rows; the 180-day audit pruning also bounds this counter. */
    refineAttemptCount(sourceId: string): number;
    /** M7: last LLM-audit timestamp for a topic cluster (undefined = never audited → audit). */
    l2RefinedTs(topic: string): number | undefined;
    /** M7: record that a topic cluster was LLM-audited at `ts` (idempotent upsert). */
    upsertL2Refined(topic: string, ts?: number): void;
    /** Content-ids already written into an auto-maintained identity file. */
    identitySyncedIds(target: string): Set<string>;
    /** Record that a memory content was written into an identity file (idempotent). */
    markIdentitySynced(content: string, target: string, ts?: number): void;
    identityMetaGet(key: string): number | undefined;
    identityMetaSet(key: string, value: number): void;
    recordFailure(memoryId: string, oldContent: string, newContent: string): void;
    failureTrail(): {
        memoryId: string;
        oldContent: string;
        newContent: string;
        correctedAt: number;
    }[];
    /** True when a failure trail still references this content (corrected-once → extend life). */
    hasPendingCorrection(content: string): boolean;
    forgetRun(cfg: {
        forgetDays?: Partial<ForgetDays>;
        episodeRetentionDays?: number;
        observeDays?: number;
    }, now?: number): ForgetResult;
}
