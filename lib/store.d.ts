import type { ApplyResult, BudgetUsage, Episode, EpisodeHit, ForgetDays, Kind, Layer, MemoryBudget, MemoryEntry, MemoryOp, RecallHit, Tier } from './types.js';
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
    constructor(home?: string, budget?: MemoryBudget, windowDays?: number, forgetDays?: ForgetDays);
    close(): void;
    private rowToEntry;
    private rowToEpisode;
    get(id: string): MemoryEntry | undefined;
    list(filter?: ListFilter): MemoryEntry[];
    activeEntries(): MemoryEntry[];
    count(): number;
    /** Tier-0 (injectable, non-archived, non-low-quality) usage. */
    usage(): BudgetUsage;
    topicsIndex(): {
        topic: string;
        count: number;
    }[];
    private autoTier;
    private writeMemory;
    private hardDeleteMemory;
    private applyOne;
    private demoteToBudget;
    private budgetOver;
    /** Model-facing write batch; lands globally and immediately. */
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
    listEpisodes(filter?: {
        includeArchived?: boolean;
    }): Episode[];
    recallEpisodes(query: string, opts?: {
        topK?: number;
    }): EpisodeHit[];
    private hardDeleteEpisode;
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
        windowDays?: number;
        episodeRetentionDays?: number;
        observeDays?: number;
    }, now?: number): ForgetResult;
}
