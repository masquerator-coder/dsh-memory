/**
 * Semantic key generation — the minimal dedup contract.
 *
 * Two facts are "the same assertion" iff their canonical semantic_key is equal,
 * so generation must be deterministic across spellings, alias forms, qualifier
 * ordering, and JSON serialization byte-for-byte differences.
 *
 *   semantic_key = sha256(canonicalSubjectId | "|" | canonicalPredicate
 *                                        | "|" | canonicalObjectId
 *                                        | "|" | qualifierSignature)
 *
 * External behavior (the byte value) is locked by snapshots in
 * `tests/semantic-key.test.ts` — see KM-LOCK notes there.
 *
 * @module dsh-memory/domain/semantic-key
 */
import { createHash } from 'node:crypto'
import type { FactQualifiers, FactType } from './fact.ts'

/**
 * Which qualifier keys participate in the semantic identity, per fact type.
 * Semantic preferences do not key on `time.valid_from` (a preference valid from
 * a date is still the same preference); episodic facts key on `event_time`.
 */
const KEY_QUALIFIERS_BY_TYPE: Record<FactType, readonly string[]> = {
  semantic: ['location', 'context', 'condition'],
  episodic: ['event_time', 'location', 'context'],
  procedural: ['context'],
  working: [],
}

/**
 * Normalize a raw qualifier object for keying: point-expand dotted keys,
 * drop null/undefined/empty values, sort keys, ISO-normalize dates, and
 * coerce numbers to a fixed precision so equivalent values compare equal.
 */
export function canonicalizeQualifiers(
  qualifiers: FactQualifiers | undefined,
  type: FactType,
): Record<string, unknown> {
  if (qualifiers === undefined) return {}
  const keyed = new Set(KEY_QUALIFIERS_BY_TYPE[type])
  const out: Record<string, unknown> = {}

  const flatten = (prefix: string, value: unknown): void => {
    if (value === null || value === undefined) return
    if (typeof value === 'string' && value.length === 0) return
    if (Array.isArray(value)) {
      if (value.length === 0) return
      out[prefix] = value.map(item => normalizeScalar(item))
      return
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      )
      for (const [k, v] of entries) flatten(prefix === '' ? k : `${prefix}.${k}`, v)
      return
    }
    out[prefix] = normalizeScalar(value)
  }

  const sortedKeys = Object.keys(qualifiers).sort()
  for (const key of sortedKeys) {
    const value = qualifiers[key]
    // Only keys that participate in identity for this type are retained.
    if (!keyed.has(key)) {
      // `time.valid_from` etc. are kept out; nested time object is not keyed
      // unless its parts are in the set (they are not for semantic).
      continue
    }
    flatten(key, value)
  }
  return out
}

/** Normalize one scalar (number precision, ISO date, trimmed string). */
function normalizeScalar(value: unknown): unknown {
  if (typeof value === 'number') {
    // Round to 10 significant digits to absorb float noise from JSON round-trips.
    return Math.round(value * 1e10) / 1e10
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    // Normalize a date/datetime to a compact ISO form when it parses as one.
    const asDate = Date.parse(trimmed)
    if (!Number.isNaN(asDate) && isProbablyDate(trimmed)) {
      return new Date(asDate).toISOString()
    }
    return trimmed
  }
  return value
}

/** Heuristic: only treat a string as a date when it "looks like" one. */
function isProbablyDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(value)
    || /^\d{2,4}[./-]\d{1,2}[./-]\d{1,2}/.test(value)
}

/** Deterministic canonical JSON (sorted keys, no whitespace) of a plain value. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortValue(obj[key])
        return acc
      }, {})
  }
  return value
}

/** SHA-256 hex digest of UTF-8 input, with an optional stable prefix tag. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Compact digest intended to be stable across fact versions. */
export function qualifierSignature(type: FactType, qualifiers: FactQualifiers | undefined): string {
  const canonical = canonicalizeQualifiers(qualifiers, type)
  return sha256Hex(canonicalJson(canonical))
}

/**
 * Build the semantic_key for an assertion.
 * @param canonicalSubjectId - resolved canonical entity id (e.g. `user:alice`).
 * @param canonicalPredicate - normalized predicate.
 * @param canonicalObjectId - resolved canonical object id or literal.
 * @param qualifierSignature - already-computed signature, or pass `qualifiers`.
 */
export function buildSemanticKey(
  canonicalSubjectId: string,
  canonicalPredicate: string,
  canonicalObjectId: string,
  qualifierSignature: string,
): string {
  return sha256Hex(
    `${canonicalSubjectId}|${canonicalPredicate}|${canonicalObjectId}|${qualifierSignature}`,
  )
}
