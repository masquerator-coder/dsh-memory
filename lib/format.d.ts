/**
 * dsh-memory-v3 — entry formatting for every model-facing listing surface.
 *
 * Extracted from tools.ts (zero dsh dependency) so smoke.mjs can unit-test it
 * directly — untestable surfaces rot silently.
 */
import type { Episode, MemoryEntry } from './types.js';
/** Render semantic memories for every model-facing listing surface. */
export declare function formatEntries(entries: readonly MemoryEntry[]): string;
/** Render episodic (session) memories. */
export declare function formatEpisodes(episodes: readonly Episode[]): string;
/** Completed-card verdict for a write. */
export declare function writeVerdictLabel(action: string): string;
/** Empty recall outcome gives the card a "no match" header. */
export declare function recallEmptyLabel(): string;
/** Whether an execute text signals a non-write outcome (rejected / overflow / unknown action). */
export declare function writeFailed(text: string): boolean;
