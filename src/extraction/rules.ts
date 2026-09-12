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

/** Leading punctuation/space left behind once the trigger phrase is removed. */
const EDGE_PUNCT = /^[\s，,。.、:：;；!！?？~～\-]+/u

/** Strip a leading trigger phrase and surrounding filler from a statement. */
function stripTrigger(text: string, trigger: string): string {
  let rest = text
  const idx = rest.indexOf(trigger)
  if (idx >= 0) {
    rest = rest.slice(idx + trigger.length)
  }
  // Drop the separator and conversational filler that follow the trigger
  // ("记住，项目部署在…" → "项目部署在…", "记住了我是素食" → "素食").
  rest = rest.replace(EDGE_PUNCT, '')
  rest = rest.replace(/^(是|就是|我|请|帮我|以后)\s*/gu, '')
  rest = rest.replace(EDGE_PUNCT, '')
  rest = rest.replace(/[\s，。！？!?]*$/gu, '')
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
      return {
        // Trigger-based captures are declarative statements about the user's
        // preferences/facts; episodic classification needs a time signal the
        // fast channel does not have.
        type: 'semantic',
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

/**
 * Heuristic guard against capturing a pasted terminal/console dump as memory.
 * Multi-line command output (a `pnpm test` transcript, an installer error log,
 * a shell history) is not durable user knowledge and pollutes the store with
 * low-value `stated` facts. We only reject when the text is clearly multi-line
 * machine output: a shell prompt, or a build/test/error transcript signal.
 *
 * Conservative by design: single-line commands/queries (e.g. "跑一下 pnpm test",
 * "为什么 EPERM？") pass through so the fast channel still works for normal talk.
 */
export function looksLikeTerminalDump(text: string): boolean {
  const norm = text.trim()
  if (!norm.includes('\n') && !norm.includes('\r')) return false

  // A shell prompt anywhere in a multi-line message (PS >, C:\>, user@host~$ …).
  const hasShellPrompt = /(?:^|\n)\s*(?:PS\s+[^\n>]*>|C:\\[^\n>]*>|[a-zA-Z_-]+@[^\n:]*[>:~$])/m.test(norm)
  const transcript = /Test Files|Tests\s+(?:passed|failed)|\bvitest\b|\bpnpm\s+\w+\b|\bnpm\s+\w+\b|\[\s*\d+\/\d+\s*\]|ELIFECYCLE|ERR_[A-Z_]+|error\s+TS\d+/i

  return hasShellPrompt
    || (transcript.test(norm) && norm.split(/\r?\n/).length >= 3)
}
