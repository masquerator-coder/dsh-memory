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
export declare function buildSection(store: MemoryStore, opts?: {
    importanceThreshold?: number;
}): SectionBuild;
/** Build an identity section from `<storeDir>/<file>` (e.g. soul.md / user.md).
 *  Missing/empty file → empty section (host omits it). File text is declared as
 *  data, not instructions (same untrusted-content rule as the tier0 section). */
export declare function buildIdentitySection(dir: string, file: string, label: string): SectionBuild;
