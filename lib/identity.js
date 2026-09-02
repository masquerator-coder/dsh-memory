/**
 * dsh-memory — identity files (soul.md / user.md), R3-i 2026-08-31.
 *
 * Since 2026-08-31 the persistent identity files are HUMAN-authored and
 * human-maintained, exactly like soul.md: the plugin auto-creates empty shells
 * on boot (so injection can render a section once the human writes content)
 * and exposes them to the settings UI over the /memory/identity HTTP route.
 *
 * What this module does NOT do anymore (cancelled 2026-09-02): the automatic
 * `maintainUserIdentity` pass that appended layer=user memories into user.md,
 * the identity_synced / identity_meta ledger tables, and the associated store
 * methods were removed. user.md is never auto-written; it is edited by hand the
 * same way soul.md is. (Old databases may still contain the orphaned tables
 * from the pre-cancellation build — they are inert and never touched.)
 *
 * soul.md is intentionally never auto-written either: an AI persona is a
 * design decision (human-authored), not something a condensation pass should
 * fabricate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
function stripBom(s) {
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
/** Create empty soul.md / user.md under `dir` when absent. Files stay empty until
 *  the human writes real content — the injection renderer treats an empty file
 *  as "no identity section". Never touches existing files (a human-authored file
 *  is never overwritten). */
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
