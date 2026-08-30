/**
 * dsh-memory — identity-file HTTP routes (R3-ui 2026-08-31).
 *
 * Exposes the soul.md / user.md files to the settings UI over one `webServer`
 * route (the same seam meow-memory uses). The files stay the source of truth
 * (decision ② A): the UI edits them through this route, and a human can still
 * hand-edit the same files.
 *
 *   GET  /memory/identity        → { ok: true, soul, user }
 *   POST /memory/identity        → { ok: true }  body: { file: 'soul'|'user', content }
 *
 * `webServer` is an optional host service that may come up after this plugin
 * (fiber startup race), so registration retries once a second (≤20 attempts)
 * and degrades silently when the seam is absent. The route is registered inside
 * a ctx.effect so a hot reload un-registers it (no duplicate-route residue).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryStore } from './store.js';
/**
 * Register the `/memory/identity` route. Returns a disposer that only cancels the
 * registration retry timer; the route itself lives in a ctx.effect so the fiber
 * un-registers it on dispose.
 */
export declare function registerIdentityRoutes(ctx: Context, store: MemoryStore): () => void;
