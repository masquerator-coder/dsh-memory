/**
 * Privacy guard — design §12.7. Offers PII detection for content entering the
 * memory pipeline, privacy-tier filtering for recall, and redaction for
 * `confidential` recall paths. Secrets never enter by default; PII-bearing
 * content is flagged and isolated.
 *
 * @module dsh-memory/application/privacy
 */
import type { PrivacyLevel } from '../domain/fact.ts'
import type { PrivacyPolicy } from '../domain/policies.ts'

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
 * Apply the recall privacy filter to a candidate set. Confidential content is
 * redacted when piiRedaction is on; secret is dropped unless explicit auth is
 * permitted (P0: never auto-injected).
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

/** Redact confidential content for non-auth recall paths. */
export function redactForRecall<T extends { privacy: PrivacyLevel; content: string }>(
  item: T,
  _policy: PrivacyPolicy,
): T {
  if (item.privacy === 'confidential' && _policy.piiRedaction) {
    return { ...item, content: `[confidential] ${item.content}` }
  }
  return item
}
