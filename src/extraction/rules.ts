/**
 * Fast-channel rules — design §6.4 mode B. A synchronous, zero-LLM matcher that
 * captures explicit memory signals ("记住", "我的偏好是", "我一般", …) and turns
 * them into low-confidence atomic facts. The main-LLM path never runs here;
 * recall/consolidate later accumulates evidence.
 *
 * This module is pure and unit-tested (the qualification that keeps the
 * fast channel low-latency and predictable).
 *
 * @module dsh-memory/extraction/rules
 */
import type { FactType } from '../domain/fact.ts'

export interface RuleMatch {
  /** Since a rule can map to multiple fact types by phrase, the primary type. */
  readonly type: FactType
  /** The captured assertion (trigger phrase stripped). */
  readonly statement: string
  /** Which trigger fired. */
  readonly trigger: string
  /** Raw subject mention when identifiable, else undefined. */
  readonly subjectMention?: string
}

/** Strip a leading trigger phrase and surrounding filler from a statement. */
function stripTrigger(text: string, trigger: string): string {
  let rest = text
  const idx = rest.indexOf(trigger)
  if (idx >= 0) {
    rest = rest.slice(idx + trigger.length)
  }
  // Drop leading conversational filler.
  rest = rest.replace(/^(是|就是|我|请|帮我|以后)\s*/g, '')
  rest = rest.replace(/[\s，。！？!?]*$/g, '')
  return rest.trim()
}

/**
 * Match fast-channel rules against a single user message.
 * @param text - the raw message.
 * @param triggers - the configured trigger phrases.
 * @returns the best capture, or null when no rule fires.
 */
export function matchRules(text: string, triggers: readonly string[]): RuleMatch | null {
  const norm = text.trim()
  if (norm.length === 0) return null

  // Preference / memory declarations.
  for (const trigger of triggers) {
    const idx = norm.indexOf(trigger)
    if (idx >= 0) {
      const statement = stripTrigger(norm, trigger)
      if (statement.length === 0) continue
      const type: FactType = /偏好|喜欢|不爱|不吃|讨厌|客气|希望/.test(statement) ? 'semantic' : 'semantic'
      return {
        type,
        statement,
        trigger,
        subjectMention: guessSubject(norm, idx),
      }
    }
  }
  return null
}

/** Best-effort subject mention preceding the trigger (heuristic). */
function guessSubject(text: string, triggerIdx: number): string | undefined {
  const before = text.slice(0, triggerIdx).trim()
  if (before.length === 0) return undefined
  // "我" / "我爸" / names — take the last 1-2 chars segment.
  const m = /([\u4e00-\u9fffA-Za-z]{1,6})\s*$/.exec(before)
  return m?.[1] ?? undefined
}

/**
 * Whether a message mentions a fact-worthy number/date/entity, used to bump a
 * capture from a rule miss into a slow-path candidate (design §6.4).
 */
export function looksFactWorthy(text: string): boolean {
  return /\d{2,}|[A-Z][a-z]+\s+[A-Z][a-z]+|版本|版本号|v\d+/.test(text)
}
