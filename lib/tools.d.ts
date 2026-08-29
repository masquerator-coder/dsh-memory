/**
 * dsh-memory-v3 — model-facing tools.
 *  - `memory`        list / add / replace / remove on the GLOBAL semantic store.
 *  - `memory_recall` search semantic + episodic pools (scope: semantic|episodic|all).
 *
 * The model-supplied values are validated at this boundary (pick/tierOf/
 * importanceOf helpers) instead of being trusted. presentCall/presentResult
 * are pure-UI card surfaces — they never touch the model context, which is the
 * `execute` return text alone.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryStore } from './store.js';
export interface RegisterOpts {
    epistemicWeighting?: boolean;
}
export declare function registerMemoryTools(ctx: Context, store: MemoryStore, opts?: RegisterOpts): void;
