/**
 * dsh-memory — entry formatting for every model-facing listing surface.
 *
 * Extracted from tools.ts (zero dsh dependency) so smoke.mjs can unit-test it
 * directly — untestable surfaces rot silently.
 */
import type { Episode, MemoryEntry } from './types.js';
/** Render semantic memories for every model-facing listing surface.
 *  (P0-6) content is untrusted model-written text; collapse newlines/control
 *  chars so a single entry can never forge an extra list line. */
export declare function formatEntries(entries: readonly MemoryEntry[]): string;
/** Render episodic (session) memories. (P0-6) same one-line guard on summary. */
export declare function formatEpisodes(episodes: readonly Episode[]): string;
/** Completed-card verdict for a write. */
export declare function writeVerdictLabel(action: string): string;
/** Empty recall outcome gives the card a "no match" header. */
export declare function recallEmptyLabel(): string;
/** Whether an execute text signals a non-write outcome (rejected / overflow / unknown action). */
export declare function writeFailed(text: string): boolean;
