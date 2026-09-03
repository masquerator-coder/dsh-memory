/**
 * dsh-memory — L1/L2 LLM-decided consolidation (episode → stable facts, then
 * semantic merge/arbitration). Mirrors l0.ts: the core decide+shape functions
 * are pure (testable without dsh); only the LLM stream and store writes are
 * injected by the caller.
 *
 * Hard constraints honored here:
 *  - These are BACKGROUND ENHANCEMENTS. They never gate recall, and a dead /
 *    missing LLM degrades cleanly: L1 marks the episode `extracted=2` (skip,
 *    no pure-rule extraction — episode text is already compressed, rule
 *    extraction would be noise); L2 simply does not merge. The core store /
 *    recall / forget loop is untouched and never says "waiting on the model".
 *  - Every LLM decision is audited into `refine_runs` (route, status, decisions).
 *  - Background runs have no session context, so a route (provider/model) must
 *    be supplied explicitly; there is no request-header to fall back on.
 */
import type { MemoryStore } from './store.js';
import type { LlmStreamSeam } from './l0.js';
import type { Epistemic, Importance, Kind } from './types.js';
export declare const DEFAULT_REFINE_MAX_TOKENS = 800;
export declare const DEFAULT_REFINE_TIMEOUT_MS = 10000;
/** R2 (review 2026-08-30): an episode whose facts keep being rejected (e.g.
 *  tier-0 budget permanently overflowed) is retried at most this many times,
 *  then marked degraded — never an infinite per-cycle LLM loop. */
export declare const L1_MAX_WRITE_RETRIES = 3;
/** A resolvable LLM route pair (provider + model). */
export interface RefineRoute {
    provider: string;
    model: string;
}
/** One candidate route source (any of provider/model may be absent). */
export interface RefineRouteSource {
    provider?: string;
    model?: string;
}
/**
 * Resolve the route for a background L1/L2 pass. Precedence: explicit config →
 * route learned from a live session request-header → host default model
 * (`agentDefaultModel.currentSelection()`), else null (caller degrades).
 * Pure: no dsh, no I/O. Returns a route only when both halves are present.
 */
export declare function resolveRefineRoute(explicit?: RefineRouteSource, learned?: RefineRouteSource, hostDefault?: RefineRouteSource): RefineRoute | null;
/** One bounded peak-hour suppression window ("HH:MM" start/end, same-day). */
export interface SuppressWindow {
    start: string;
    end: string;
}
/** M8: peak-hour suppression config (API peak/valley pricing — skip LLM burn
 *  during expensive windows). orthogonal to idle: gating is pure time, not
 *  activity. Same-day windows only (a window that crosses midnight is not
 *  supported — split it into two entries). */
export interface SuppressCfg {
    suppressWindows: SuppressWindow[];
    suppressLeadMinutes: number;
    timeZone: string;
}
/** M8: true when `now` (in cfg.timeZone) falls inside any suppression window or
 *  the `suppressLeadMinutes` immediately before one. Pure — no I/O, testable. */
export declare function isSuppressedRaw(now: Date, cfg: SuppressCfg, tzHour: number, tzMinute: number): boolean;
/** M8: resolve hour/minute in cfg.timeZone then delegate to {@link isSuppressedRaw}.
 *  Falls back to UTC wall-clock on an unknown/invalid timeZone. */
export declare function isSuppressed(now: Date, cfg: SuppressCfg): boolean;
/** One stable fact extracted from an episode by L1. */
export interface ExtractedFact {
    content: string;
    kind?: Kind;
    importance?: Importance;
    epistemic?: Epistemic;
    topic?: string;
}
/** One consolidation verdict over a semantic cluster by L2. */
export interface L2Verdict {
    action: 'merge' | 'keep' | 'drop' | 'correct';
    targetIds?: string[];
    content?: string;
    kind?: Kind;
}
/**
 * Parse L1 model output into facts. Tolerant: strips markdown fences, skips
 * malformed members, clamps importance, narrows kind/epistemic to the closed
 * sets. Returns a (possibly empty) array on a structurally valid JSON array,
 * or null on a parse failure (→ treated as degraded).
 */
export declare function parseL1Json(text: string): ExtractedFact[] | null;
/** Parse L2 model output into verdicts. Empty-but-valid → [] (keep all). */
export declare function parseL2Json(text: string): L2Verdict[] | null;
/** Build the L1 system + framed user prompt (JSON-framed input prevents leakage). */
export declare function buildL1Prompt(summary: string, toolsUsed?: string): {
    system: string;
    user: string;
};
/** R8 (2026-09-03): user prompt for ONE corrective L1 retry. Feeds the offending
 *  model output back and re-demands the strict JSON contract. v4-flash-class
 *  models intermittently drift off the contract (prose / fences / truncated
 *  arrays); a hard parse failure on real output is the dominant cause of
 *  degraded episodes in the field, and a single correction recovers most of
 *  them without an unbounded retry loop. */
export declare function buildL1RetryUser(summary: string, toolsUsed: string | undefined, badRaw: string): string;
/** Build the L2 system + framed user prompt over a cluster of candidate facts. */
export declare function buildL2Prompt(facts: {
    id: string;
    content: string;
    kind?: Kind;
    importance?: Importance;
}[]): {
    system: string;
    user: string;
};
export interface RefineInput {
    llm?: LlmStreamSeam | null;
    provider?: string;
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
    retryDegraded?: boolean;
    sessionId?: string;
    limit?: number;
    /** M7: only audit clusters whose members changed since the last audit (zero-LLM
     *  for stable clusters). Accepts `runRefineSession` and other callers. */
    incremental?: boolean;
}
/**
 * Run L1 extraction over pending episodes. Per episode: LLM decides the stable
 * facts (or that there are none); approved facts are written through
 * store.batch (so dedup/quality/tier apply) and the episode is marked
 * extracted=1. A missing/failed route or unparseable output marks extracted=2
 * (degraded-skip) with an audit row. Budget overflow falls back to writing
 * facts one-at-a-time so a tier-0 squeeze never loses facts silently.
 * R2 (review 2026-08-30): an episode whose facts are persistently rejected
 * (budget) is retried at most L1_MAX_WRITE_RETRIES times, then degraded —
 * never an infinite per-cycle LLM loop; its audit rows read 'ok-noop'.
 * Never throws to the caller.
 */
export declare function runRefineL1(store: MemoryStore, input?: RefineInput): Promise<{
    processed: number;
    degraded: number;
    factsWritten: number;
    runIds: number[];
}>;
/**
 * Run L2 consolidation over semantic clusters. Each cluster goes to the LLM for
 * merge/keep/drop/correct verdicts; applied verdicts rewrite the store through
 * batch (merge = add merged + archive originals; drop = archive; correct =
 * replace — all soft/reversible). A missing route skips L2 entirely (core stays
 * untouched); a per-cluster failure logs a degraded run without touching data.
 * Never throws to the caller.
 */
export declare function runRefineL2(store: MemoryStore, input?: RefineInput & {
    minCluster?: number;
}): Promise<{
    clusters: number;
    degraded: number;
    verdictsApplied: number;
    runIds: number[];
}>;
/** One lesson draft as seen by the judge prompt (minimal input, DESIGN §0 #4). */
export interface LessonDraftForJudge {
    id: number;
    topic: string;
    oldContent: string | null;
    newContent: string | null;
    draftCount: number;
}
/** Build the lesson-judge system + framed user prompt (DESIGN §2.4). */
export declare function buildLessonJudgePrompt(drafts: LessonDraftForJudge[]): {
    system: string;
    user: string;
};
export interface LessonJudgement {
    index: number;
    decision: 'promote' | 'drop';
    lesson?: string;
    importance?: number;
}
/** Parse lesson-judge model output. Structurally valid array → judgements (possibly
 *  empty); unparseable → null (treated as degraded, drafts retained). */
export declare function parseLessonJudgements(text: string): LessonJudgement[] | null;
export interface LessonPromoteInput {
    llm?: LlmStreamSeam | null;
    provider?: string;
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
    /** false → pure-rule template promotion (degraded fallback, no LLM seam call). */
    lessonUseLlm?: boolean;
    /** true → judge only the single newest draft (fire-and-forget after replace). */
    instant?: boolean;
    limit?: number;
}
/**
 * Promote staged lesson drafts (DESIGN §2.4): (a)/(b) → write a `kind=lesson`
 * memory through store.batch (so dedup/quality/tier apply), mark the draft
 * promoted; (c) → mark dropped. With lessonUseLlm=false or a missing route, falls
 * back to pure-rule template promotion (the template text is always present).
 * A failed/unparseable judgement keeps drafts for the next pass and audits
 * `degraded`. Never throws to the caller.
 */
export declare function runRefineLessonPromote(store: MemoryStore, input?: LessonPromoteInput): Promise<{
    promoted: number;
    dropped: number;
    degraded: number;
    runIds: number[];
}>;
/** Build the add-meta judge prompt for one content string (DESIGN §3.1). */
export declare function buildAddMetaPrompt(content: string): {
    system: string;
    user: string;
};
/** Parse add-meta judge output. Null on unparseable. */
export declare function parseAddMetaJson(text: string): {
    kind?: Kind;
    importance?: number;
} | null;
/**
 * Judge add-meta (kind + importance) for one content (DESIGN §3.1), returning a
 * pair to merge into a write. Missing route / LLM failure → null (caller keeps
 * the rule defaults). This is the seam an add-site or a background calibration
 * pass calls; it never touches the agent context and never blocks the write.
 */
export declare function judgeAddMeta(store: MemoryStore, content: string, input: {
    llm?: LlmStreamSeam | null;
    provider?: string;
    model?: string;
    timeoutMs?: number;
}): Promise<{
    kind?: Kind;
    importance?: number;
} | null>;
