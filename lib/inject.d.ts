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
import { type MemoryEntry } from './types.js';
export interface SectionBuild {
    text: string;
    empty: boolean;
}
/** Per-entry cap (chars) — a runaway memory can't bloat the system prompt. */
export declare const ENTRY_CAP = 300;
/** Whole-section cap (chars) — hard stop on injected volume regardless of count. */
export declare const SECTION_CAP = 8000;
/** Cap (chars) for the user-authored `memory:custom` instruction block (P1/M1,
 *  2026-09-07). Every other injected section is budget-gated (SECTION_CAP /
 *  ENTRY_CAP / identity mtime cache); this was the only one injected verbatim
 *  with no ceiling, so a very long customSystemPrompt could bloat the resident
 *  system prompt and ride every KV prefix. Injected text is clamped here; the
 *  length guard is the injection-side hard floor — see index.ts memory:custom. */
export declare const CUSTOM_CAP = 8000;
/** Cap (chars) for a single identity file body (soul.md / user.md) injected into
 *  the system prompt (audit 2026-09-07, item ③). The tier0 path had
 *  sanitize + escHtml + SECTION_CAP, but buildIdentitySection injected the raw
 *  file verbatim — a large user.md can bloat the resident prompt and a literal
 *  `</identity-data>` could break the container. */
export declare const IDENTITY_CAP = 8000;
/** Newline-preserving sanitizer for identity markdown (audit 2026-09-07, item ③).
 *  Deliberately NOT the tier0 `sanitizeText`: that folds `\s+` → single space,
 *  which would flatten soul.md/user.md line structure (titles, lists). Identity
 *  files keep their author-authored markdown lines; we only strip control
 *  characters (keeping \n \r \t), normalize CRLF/CR → LF, and truncate to
 *  `cap`. Escaping of structural `& < > "` is applied separately via escHtml. */
export declare function sanitizeIdentity(raw: string, cap?: number): string;
/** M1 (2026-09-07): clamp the user-authored custom system-prompt block to
 *  `cap` (default CUSTOM_CAP) for injection. Non-string or blank → '' (no
 *  section); longer text is trimmed then truncated so it can't bloat the
 *  resident system prompt. Kept a pure function so the memory:custom thunk and
 *  the smoke suite share one implementation. */
export declare function clampCustomPrompt(raw: unknown, cap?: number): string;
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
 *  data, not instructions (same untrusted-content rule as the tier0 section).
 *  P0-5: like the tier0 `<memory-data>` container, the data BODY (the raw
 *  human-authored markdown) is wrapped in an explicit `<identity-data>…</identity-data>`
 *  container (2026-09-07). The title + declaration live OUTSIDE the container,
 *  describing it; the closing tag makes the "identity data ends here" boundary
 *  explicit so the model never reads the following segments (platform system
 *  prompt / tool guidance / other sections) as identity/portrait data. Both tags
 *  are constant literals → byte-stable per mtime (KV-prefix friendly). */
export declare function buildIdentitySection(dir: string, file: string, label: string): SectionBuild;
export declare const PROTOCOL_TEXT: string;
/** Gate helper: returns the constant rules when enabled, '' when the master
 *  switch is off (clean sessions) — read inside the section's text thunk so the
 *  R3-total live-toggle tears the section down/up without a restart. */
export declare function protocolSectionText(enabled: boolean): string;
export declare const WRITE_BOUNDARY_TEXT: string;
/** 返回待沉淀草稿提示文本;无 pending 草稿时返回 ''(空 section,宿主省略)。 */
export declare function draftsSectionText(count: number): string;
