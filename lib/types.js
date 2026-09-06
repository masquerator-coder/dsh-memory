/** dsh-memory shared types. Zero dsh dependency. */
/** The only kinds buildSection renders into the system prompt (audit ②,
 *  2026-09-07). Budget alignment: `enforceBudget`'s memory-injection bucket counts
 *  exactly these, so uninjectable kinds (lesson/decision/general) never eat the
 *  budget quota that gates preference/env injection. Shared single source of the
 *  injection-kind axis — store.ts and inject.ts both read it, so the budget gate
 *  and the injection gate can't drift apart again. */
export const INJECT_KINDS = ['preference', 'env'];
export function isInjectableKind(kind) {
    return kind === 'preference' || kind === 'env';
}
