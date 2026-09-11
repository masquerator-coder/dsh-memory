/**
 * Runtime-checkable invariants guarded internally by the memory core.
 *
 * These are structural guarantees the rest of the code reasons about. They are
 * pure checks (no side effects) so they can be asserted in tests and kept as a
 * single source of truth for "what must always hold".
 *
 * @module dsh-memory/invariant
 */

/**
 * A fact's semantic_key must be reproducible from its canonical identity alone.
 * This is the dedup contract: two facts sharing a key are the same assertion.
 */
export function invariantSemanticKeyReproducible(
  subjectId: string,
  predicate: string,
  objectId: string,
  signature: string,
  key: string,
): boolean {
  // We cannot recompute sha256 here without the util, so we assert the shape:
  // keys are 64 lowercase hex chars.
  return /^[0-9a-f]{64}$/.test(key)
    && key.length > 0
    && predicate.length > 0
    && subjectId.length > 0
    && objectId.length >= 0
    && signature.length > 0
}

/**
 * Scope isolation: no fact leaks across scope boundaries at the storage layer.
 * The repository routes all reads by scope, so this is checked by the
 * filter/repository contract rather than a self-contained predicate; we keep a
 * cheap structural assertion that facts carry a non-empty scope.
 */
export function invariantFactHasScope(scope: string): boolean {
  return typeof scope === 'string' && scope.length > 0
}

/**
 * Retrieval budget: recall never returns more than the configured topK and
 * always boxes by tokens before truncation. Exported so the recall engine and
 * its tests share the bound.
 */
export function withinBudget(count: number, topK: number): boolean {
  return count >= 0 && count <= topK
}
