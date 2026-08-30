import { type MemoryStore } from './store.js';
/** Default cap on an auto-maintained identity file (bytes, UTF-8). */
export declare const IDENTITY_MAX_BYTES = 2000;
/** Create empty soul.md / user.md under `dir` when absent. Files stay empty until
 *  the maintenance pass (or the user) writes real content — the injection renderer
 *  treats an empty file as "no identity section". Never touches existing files. */
export declare function autocreateIdentityFiles(dir: string): {
    created: string[];
    skipped: string[];
};
export interface MaintainResult {
    /** unsynced user-layer candidates found this run */
    candidates: number;
    /** entries actually appended to the identity file */
    wrote: number;
    /** entries skipped because the file size cap was hit */
    overflow: number;
}
/** Incremental, zero-LLM maintenance of `user.md` from the semantic store's
 *  `layer=user` memories. Dedups via contentId(content) in `identity_synced`.
 *  No unsynced candidate → returns `{candidates:0,...}` without writing (the
 *  "no new content → no maintenance" gate). File capped at `maxBytes`. */
export declare function maintainUserIdentity(store: MemoryStore, dir: string, opts?: {
    maxBytes?: number;
}): MaintainResult;
