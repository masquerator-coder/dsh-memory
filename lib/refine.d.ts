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
}
/**
 * Run L1 extraction over pending episodes. Per episode: LLM decides the stable
 * facts (or that there are none); approved facts are written through
 * store.batch (so dedup/quality/tier apply) and the episode is marked
 * extracted=1. A missing/failed route or unparseable output marks extracted=2
 * (degraded-skip) with an audit row. Budget overflow falls back to writing
 * facts one-at-a-time so a tier-0 squeeze never loses facts silently.
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
