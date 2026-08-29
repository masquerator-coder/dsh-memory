/**
 * dsh-memory — Tier-0 injection renderer.
 *
 * Rendered as the text of a systemPrompt.section whose provider is re-evaluated
 * at every prompt assembly, so it is always fresh from the global store and
 * survives compaction (it lives in the system prompt, not the chat history).
 */
import type { MemoryStore } from './store.js';
export interface SectionBuild {
    text: string;
    empty: boolean;
}
export declare function buildSection(store: MemoryStore, opts?: {
    importanceThreshold?: number;
}): SectionBuild;
