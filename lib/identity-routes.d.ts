/**
 * dsh-memory — identity-file + memory-control HTTP routes (R3-ui 2026-09-02).
 *
 * Exposes the soul.md / user.md files AND the memory condensation workflow to
 * the settings UI over one `webServer` seam (the same route family meow-memory
 * uses). The files stay the source of truth (decision ② A): the UI edits them
 * through this route, and a human can still hand-edit the same files.
 *
 *   GET  /memory/identity        → { ok: true, soul, user }
 *   POST /memory/identity        → { ok: true }          body: { file: 'soul'|'user', content }
 *   POST /memory/identity/open   → { ok: true, path }    body: { file: 'soul'|'user' }  — open in a local editor
 *   POST /memory/trigger         → { ok: true, result }  — run an immediate condensation/identity/forget pass
 *   GET  /memory/view            → { ok: true, ...digest } — memory digest for the viewer window
 *
 * SECURITY (P1-3/G2/G3, review 2026-09-01): every route requires a loopback
 * source. The check uses socket.remoteAddress (transport-layer fact, cannot be
 * spoofed via Host/Origin headers). This blocks LAN clients and DNS-rebinding
 * pages even when the webServer is bound beyond loopback.
 *
 * `webServer` is an optional host service that may come up after this plugin
 * (fiber startup race), so registration retries once a second (≤20 attempts)
 * and degrades silently when the seam is absent. The routes are registered
 * inside a ctx.effect so a hot reload un-registers them (no duplicate residue).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryStore } from './store.js';
/** Result of an immediate "整理记忆" pass, returned by the trigger route. */
export interface RunNowResult {
    refined: boolean;
    forgetDemoted: number;
    forgetArchivedMem: number;
    forgetDeletedMem: number;
    forgetArchivedEpi: number;
    forgetDeletedEpi: number;
}
/** Handlers wired in by the plugin entry (where the actual pass closures live). */
export interface MemoryControlHandlers {
    /** Run condensation (L1/L2) + identity maintenance + forgetting immediately. */
    runNow: () => Promise<RunNowResult>;
}
/** One memory row in the viewer digest. */
export interface ViewMemory {
    id: string;
    layer: string;
    tier: number;
    kind: string;
    topic: string;
    importance: number;
    content: string;
    created: number;
    updated: number;
    archived: boolean;
    lowQuality: boolean;
}
/** Digest payload for the "查看记忆" viewer window. */
export interface ViewPayload {
    memories: ViewMemory[];
    memoryCount: number;
    episodeCount: number;
    topics: {
        topic: string;
        count: number;
    }[];
    updatedMs: number;
}
/**
 * Register the dsh-memory HTTP routes. Returns a disposer that only cancels the
 * registration retry timer; each route itself lives in a ctx.effect so the
 * fiber un-registers it on dispose.
 */
export declare function registerControlRoutes(ctx: Context, store: MemoryStore, handlers: MemoryControlHandlers): () => void;
