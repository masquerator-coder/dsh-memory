/**
 * Privacy guard — design §12.7. Offers PII detection for content entering the
 * memory pipeline, privacy-tier filtering for recall, and redaction for
 * `confidential` recall paths. Secrets never enter by default; PII-bearing
 * content is flagged and isolated.
 *
 * This module owns the **single read-path gate** ({@link factAllowed}) used by
 * both the store's query filter and the recall engine, so the two can never
 * drift apart: a fact the tier list admits can still be dropped for being
 * `secret` (needs explicit authorization) or PII-flagged (never auto-injected).
 *
 * @module dsh-memory/application/privacy
 */
import type { AtomicFact, PrivacyLevel } from '../domain/fact.ts'
import type { PrivacyPolicy } from '../domain/policies.ts'
import { isExpired } from '../domain/policies.ts'
import type { FactFilter } from './ports.ts'

/** Result of scanning input for sensitive content. */
export interface PiiScan {
  readonly detected: boolean
  readonly kinds: readonly string[]
  readonly redacted: string
  readonly excerpt: string
}

// Conservative recognizers. Passwords are intentionally hard to detect well;
// we flag explicit "password/secret/api key = X" patterns and obvious formats.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
const CN_ID_RE = /\b[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/
const BANKCARD_RE = /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14})\b/
const PHONE_RE = /\b1[3-9]\d{9}\b/
const PASSWORD_HINT_RE = /(password|passwd|密码|api[ _-]?key|access[ _-]?key|secret|凭证|token)\s*[:=]\s*\S+/i

/** Detect PII / secrets and return a redacted copy of the text. */
export function scanPii(text: string): PiiScan {
  const kinds: string[] = []
  let redacted = text

  const apply = (re: RegExp, label: string, replace: (m: string) => string): void => {
    if (re.test(redacted)) {
      kinds.push(label)
      redacted = redacted.replace(re, replace)
    }
  }

  // Order matters: replace largest/structured identifiers first.
  apply(CN_ID_RE, 'cn_id', () => '<<id>>')
  apply(BANKCARD_RE, 'bank_card', () => '<<card>>')
  apply(PHONE_RE, 'phone', () => '<<phone>>')
  apply(EMAIL_RE, 'email', () => '<<email>>')
  apply(PASSWORD_HINT_RE, 'secret', m => m.replace(/[:=]\s*\S+$/, '= <<redacted>>'))

  const unique = [...new Set(kinds)]
  return { detected: unique.length > 0, kinds: unique, redacted, excerpt: text.slice(0, 120) }
}

/** Whether a privacy level is permitted by the retrieval filter. */
export function privacyAllowed(level: PrivacyLevel, filter: readonly PrivacyLevel[]): boolean {
  return filter.includes(level)
}

/**
 * The one read-path gate (§12.7), shared by the store's `applyFilter` and the
 * recall engine's local guard:
 *
 * - `scope` / `status` / `types` / `indexState` / `now` — the plain selectors;
 * - `privacy` — the tier list the deployment allows to be surfaced;
 * - `pii: true` — *only* PII facts (a selector, not a filter);
 * - `excludePii` — drop PII-flagged facts (the model-facing default: PII is
 *   flagged at capture time and must never be auto-injected);
 * - `excludeSecret` — drop `secret` facts regardless of the tier list, because
 *   surfacing them requires explicit authorization the plugin does not model.
 */
export function factAllowed(fact: AtomicFact, filter: FactFilter): boolean {
  if (filter.scope !== undefined && fact.scope !== filter.scope) return false
  if (filter.status !== undefined && !filter.status.includes(fact.status)) return false
  if (filter.privacy !== undefined && !filter.privacy.includes(fact.privacy)) return false
  if (filter.excludeSecret === true && fact.privacy === 'secret') return false
  if (filter.excludePii === true && fact.pii) return false
  if (filter.pii === true && fact.pii !== true) return false
  if (filter.types !== undefined && !filter.types.includes(fact.type)) return false
  if (filter.indexState !== undefined && !filter.indexState.includes(fact.index_state)) return false
  if (filter.now !== undefined && isExpired(fact, filter.now)) return false
  return true
}

/**
 * Apply the recall privacy filter to a candidate set (§12.7):
 * confidential survives; secret is dropped unless explicitly authorized.
 *
 * Used on the read paths that bypass the store's own query filter (the recall
 * degradation fallback), so every path to the model passes one gate.
 */
export function filterByPrivacy<T extends { privacy: PrivacyLevel; content: string; pii: boolean }>(
  items: readonly T[],
  policy: PrivacyPolicy,
  allowSecret = false,
): T[] {
  return items.filter(item => {
    if (item.privacy === 'secret' && !allowSecret) return false
    return privacyAllowed(item.privacy, policy.retrievalFilter)
  })
}

/**
 * Redact a fact for a non-auth recall path (§12.7 "confidential → 脱敏后注入").
 * PII patterns inside confidential content are masked and the tier is marked so
 * the model knows not to echo it. Only applies when `piiRedaction` is on.
 */
export function redactForRecall<T extends { privacy: PrivacyLevel; content: string }>(
  item: T,
  policy: PrivacyPolicy,
): T {
  if (item.privacy !== 'confidential' || !policy.piiRedaction) return item
  const scanned = scanPii(item.content)
  return { ...item, content: `[confidential] ${scanned.redacted}` }
}
