/**
 * dsh-memory — Tier-0 injection renderer.
 *
 * Rendered as the text of a systemPrompt.section whose provider is re-evaluated
 * at every prompt assembly, so it is always fresh from the global store and
 * survives compaction (it lives in the system prompt, not the chat history).
 *
 * SECURITY (P0-5): memory content is written by the model and lands in the
 * system prompt (highest trust level), so it is treated as untrusted text here:
 *  - a declaration header states the blocks are historical DATA, not instructions
 *  - every entry is wrapped in an explicit `<memory-entry …>` delimiter
 *  - control characters / newlines are collapsed so one entry can't forge a list
 *  - markdown-structural leading chars are escaped so content can't spoof headings
 *  - per-entry and whole-section length caps bound the injection volume
 */
import type { MemoryStore } from './store.js';
import type { MemoryEntry } from './types.js';
export interface SectionBuild {
    text: string;
    empty: boolean;
}
/** Per-entry cap (chars) — a runaway memory can't bloat the system prompt. */
export declare const ENTRY_CAP = 300;
/** Whole-section cap (chars) — hard stop on injected volume regardless of count. */
export declare const SECTION_CAP = 8000;
/** Collapse newlines/control chars, trim, clamp length, and neutralize leading
 *  markdown structure — the content may not inject lines or fake structure. */
export declare function sanitizeText(raw: string, cap?: number): string;
/** FOLD (P1, 2026-09-06): collapse near-duplicate tier-0 entries before
 *  injection so one fact — even if it was re-written/duplicated in the store by
 *  a non-findCanonical path — is presented only once in the system prompt.
 *
 *  Conservative: folds only within the SAME kind and only when
 *  `isNearDupCandidate` fires. That gate needs BOTH a contiguous run (LCS>=0.55)
 *  AND a shared token mass (tokenContain>=0.55), so it catches re-worded
 *  duplicates that strict SIM_DUP would miss, yet does NOT collapse distinct
 *  facts that merely share boilerplate (verified: two different workspace paths
 *  score tokenContain 0.44 / LCS 0.21 → not folded). Earlier entries (list() is
 *  ordered `updated DESC`, newest first) win as the canonical representative.
 *  Pure rule, zero LLM, bounded — safe for the hot injection path. */
export declare function foldNearDuplicates(entries: MemoryEntry[]): MemoryEntry[];
export declare function buildSection(store: MemoryStore, opts?: {
    importanceThreshold?: number;
}): SectionBuild;
/** Build an identity section from `<storeDir>/<file>` (e.g. soul.md / user.md).
 *  Missing/empty file → empty section (host omits it). File text is declared as
 *  data, not instructions (same untrusted-content rule as the tier0 section). */
export declare function buildIdentitySection(dir: string, file: string, label: string): SectionBuild;
export declare const PROTOCOL_TEXT: string;
/** Gate helper: returns the constant rules when enabled, '' when the master
 *  switch is off (clean sessions) — read inside the section's text thunk so the
 *  R3-total live-toggle tears the section down/up without a restart. */
export declare function protocolSectionText(enabled: boolean): string;
export declare const WRITE_BOUNDARY_TEXT: string;
