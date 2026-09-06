/**
 * dsh-memory — layered Markdown export (MD-EXPORT, 2026-09-06).
 *
 * Renders the whole memory store into human-readable/portable Markdown files,
 * one per storage carrier (semantic memories / episodic summaries / identity
 * files). Zero LLM, zero dsh dependency — pure functions over the store's data
 * so smoke.mjs can unit-test every renderer directly (same discipline as
 * format.ts).
 *
 * Layering, per the user's decisions in docs/MD-EXPORT.md:
 *   - 01-memories.md  — ALL semantic memories, split by state (valid / archived
 *                       / low-quality) → layer → kind → importance.
 *   - 02-episodes.md  — ALL session summaries (incl. archived), time desc.
 *   - 03-identity.md  — soul.md / user.md verbatim.
 *
 * SECURITY: `content` is model-written untrusted text. It is rendered through
 * mdSafe() which escapes every Markdown structure character and collapses
 * newlines/control chars so a single entry can never forge a heading, list
 * item, or another entry (mirrors format.ts's oneLine guard, but for a
 * human-readable archive where the text is un-trusted input).
 */
import type { Episode, MemoryEntry } from './types.js';
import type { MarkdownExportFile, MarkdownExportSummary } from './shared-types.js';
export type { MarkdownExportFile, MarkdownExportSummary };
/** Escape every Markdown structure character so content cannot forge structure.
 *  Mirrors format.ts's intent but for a one-line list body (no <br> needed).
 *  `-` is escaped too: a body that starts a line with `- ` (only reachable if a
 *  caller ever stops collapsing newlines) would otherwise forge a nested list. */
export declare function mdSafe(text: string): string;
/** 01-memories.md — ALL semantic memories by state. */
export declare function renderMemoriesMarkdown(entries: readonly MemoryEntry[]): string;
/** 02-episodes.md — ALL session summaries, time descending. */
export declare function renderEpisodesMarkdown(episodes: readonly Episode[]): string;
/** 03-identity.md — soul.md / user.md verbatim. */
export declare function renderIdentityMarkdown(soul: string, user: string): string;
/** Assemble the full three-file bundle + summary from the raw store data.
 *  Keep the signature store-agnostic: pass in the three data slices. */
export declare function buildMarkdownBundle(deps: {
    memories: MemoryEntry[];
    episodes: Episode[];
    soul: string;
    user: string;
}): MarkdownExportSummary;
