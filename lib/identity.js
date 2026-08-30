/**
 * dsh-memory — auto-maintained identity files (soul.md / user.md), R3-i 2026-08-31.
 *
 * Two goals from the user:
 *  1. create empty identity files on boot; progressively fill them as the memory
 *     condensation layer yields durable content;
 *  2. cap file growth, and only touch files when there is genuinely new content
 *     to add ("先扫描，没新增不维护").
 *
 * Design (kept minimal & zero-LLM):
 *  - `autocreateIdentityFiles` creates empty soul.md / user.md if absent.
 *  - `maintainUserIdentity` is a pure-rule pass: it scans the semantic store for
 *    `layer=user` memories, appends the ones not yet synced into user.md (dedup
 *    key = contentId(content)), and records them in `identity_synced`. If there
 *    is no unsynced candidate, it returns immediately without touching the file
 *    (the "no new content → no maintenance" gate).
 *  - File size is capped at `maxBytes`; once reached, further appends are
 *    skipped (the file is protected, never truncated).
 *
 * soul.md is intentionally NOT auto-written: an AI persona is a design decision
 * (human-authored), not something a condensation pass should fabricate. The file
 * is auto-created and injected, but its content stays human-maintained. (The
 * maintain function is structured so a soul source can be added later without
 * reworking the ledger.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentId } from './store.js';
/** Default cap on an auto-maintained identity file (bytes, UTF-8). */
export const IDENTITY_MAX_BYTES = 2000;
function stripBom(s) {
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
/** Create empty soul.md / user.md under `dir` when absent. Files stay empty until
 *  the maintenance pass (or the user) writes real content — the injection renderer
 *  treats an empty file as "no identity section". Never touches existing files. */
export function autocreateIdentityFiles(dir) {
    mkdirSync(dir, { recursive: true });
    const created = [];
    const skipped = [];
    for (const file of ['soul.md', 'user.md']) {
        const p = join(dir, file);
        if (existsSync(p)) {
            skipped.push(file);
            continue;
        }
        writeFileSync(p, '', 'utf8'); // UTF-8 without BOM (Windows trap)
        created.push(file);
    }
    return { created, skipped };
}
/** Incremental, zero-LLM maintenance of `user.md` from the semantic store's
 *  `layer=user` memories. Dedups via contentId(content) in `identity_synced`.
 *  No unsynced candidate → returns `{candidates:0,...}` without writing (the
 *  "no new content → no maintenance" gate). File capped at `maxBytes`. */
export function maintainUserIdentity(store, dir, opts = {}) {
    const maxBytes = opts.maxBytes ?? IDENTITY_MAX_BYTES;
    const target = 'user';
    const file = join(dir, 'user.md');
    const candidates = store.list({ layer: 'user', includeArchived: false, includeLowQuality: false });
    const synced = store.identitySyncedIds(target);
    const todo = candidates.filter(e => !synced.has(contentId(e.content)));
    store.identityMetaSet('last_maintain', Date.now()); // a scan happened even if nothing to write
    if (todo.length === 0)
        return { candidates: 0, wrote: 0, overflow: 0 };
    const existing = existsSync(file) ? stripBom(readFileSync(file, 'utf8')) : '';
    let buf = existing;
    let base = Buffer.byteLength(buf, 'utf8');
    let wrote = 0;
    let overflow = 0;
    for (const e of todo) {
        if (base >= maxBytes) {
            overflow += todo.length - wrote;
            break;
        }
        const line = `- ${e.content.trim()}\n`;
        const add = Buffer.byteLength(line, 'utf8');
        if (base + add > maxBytes) {
            overflow += 1;
            continue;
        }
        buf += line;
        base += add;
        store.markIdentitySynced(e.content, target);
        wrote += 1;
    }
    if (wrote > 0)
        writeFileSync(file, buf, 'utf8'); // UTF-8, no BOM
    return { candidates: todo.length, wrote, overflow };
}
/** Read both identity files (missing file → empty string). Used by the settings
 *  UI's identity editor over the HTTP route. */
export function readIdentityFiles(dir) {
    const read = (file) => {
        const p = join(dir, file);
        return existsSync(p) ? stripBom(readFileSync(p, 'utf8')) : '';
    };
    return { soul: read('soul.md'), user: read('user.md') };
}
/** Overwrite one identity file with UTF-8 (no BOM — the Windows trap). `file`
 *  is narrowed to the two known names, so a caller cannot escape the identity
 *  directory via path traversal. */
export function writeIdentityFile(dir, file, content) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file === 'soul' ? 'soul.md' : 'user.md'), content, 'utf8');
}
