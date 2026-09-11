/**
 * Fact id generation — compact, sortable, collision-resistant ids.
 *
 * Format: `fact_<base32-time><base32-random>` so rows are independent of a
 * global counter and can be merged across shards.
 *
 * @module dsh-memory/domain/id
 */
import { randomBytes, randomUUID } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Base36 encoding of a non-negative safe integer. */
function base36(value: number): string {
  let n = Math.floor(value)
  let out = ''
  do {
    out = ALPHABET[n % 36] + out
    n = Math.floor(n / 36)
  } while (n > 0)
  return out
}

/**
 * Create a new fact id. `now` is injectable for deterministic tests.
 */
export function newFactId(now: number = Date.now()): string {
  const time = base36(now).padStart(8, '0').slice(-8)
  const rand = randomBytes(6).toString('hex')
  return `fact_${time}_${rand}`
}

/** Create a scope id from a session id (normalized, reversible prefix). */
export function scopeFromSessionId(sessionId: string): string {
  return `session:${sanitizeScope(sessionId)}`
}

/** A stable id for users/entities created from free text (content-addressed). */
export function newEntityId(type: string, key: string): string {
  const suffix = randomUUID().slice(0, 8)
  return `${type}:${sanitizeScope(key)}-${suffix}`
}

/** Keep scope strings path/journal safe (letters, digits, `:`, `-`, `_`, `.`). */
export function sanitizeScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9:._-]/g, '_')
}
