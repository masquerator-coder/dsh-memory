/**
 * Procedural memory serialization (design §3.12, P0→P2). Turns a P0-era
 * procedure stored only as `content` (numbered step lines) and/or a natural
 * step description into structured, validated `ProceduralStep[]` with
 * `tool`, `depends_on`, `on_failure`, and `rollback`, plus the derived
 * `tool_chain` projection and `preconditions`.
 *
 * The module is dependency-free and deterministic so it can be unit-tested and
 * reused by the extraction path, `memory_remember`, and the user.md renderer.
 *
 * @module dsh-memory/domain/procedural
 */
import type { ProceduralStep } from './fact.ts'

/** Shape accepted when authoring a procedure (from a tool or extraction). */
export interface ProcedureInput {
  /** Ordered steps. Each tool call becomes one step. */
  readonly steps?: readonly (string | Partial<ProceduralStep>)[]
  readonly preconditions?: readonly string[]
  readonly success_rate?: number
}

export interface NormalizedProcedure {
  readonly steps: ProceduralStep[]
  readonly preconditions: string[]
  readonly tool_chain: string[]
  readonly success_rate?: number
}

/** Fields a step may additionally carry; defaulted safely. */
interface StepSeed {
  readonly id: string
  readonly tool: string
  readonly depends_on?: readonly string[]
  readonly parallel_group?: string | null
  readonly on_failure?: 'abort' | 'rollback' | 'continue'
  readonly retry?: { readonly max?: number; readonly backoff?: 'fixed' | 'exponential' }
  readonly rollback?: string | null
}

const FAILURE_MODES = new Set(['abort', 'rollback', 'continue'])
const BACKOFFS = new Set(['fixed', 'exponential'])

function sanitizeRetry(retry: unknown): { max?: number; backoff?: 'fixed' | 'exponential' } | undefined {
  if (retry === null || retry === undefined || typeof retry !== 'object') return undefined
  const r = retry as { max?: unknown; backoff?: unknown }
  const out: { max?: number; backoff?: 'fixed' | 'exponential' } = {}
  if (typeof r.max === 'number' && Number.isFinite(r.max) && r.max >= 0) out.max = Math.floor(r.max)
  if (typeof r.backoff === 'string' && BACKOFFS.has(r.backoff)) out.backoff = r.backoff as 'fixed' | 'exponential'
  return Object.keys(out).length > 0 ? out : undefined
}

/** Coerce one input step (string or object) to a validated step seed. */
function toSeed(step: string | Partial<ProceduralStep>, index: number): StepSeed {
  if (typeof step === 'string') {
    const name = step.trim()
    return { id: `step_${index}`, tool: name.length > 0 ? name : `step_${index}` }
  }
  const tool = (step.tool ?? '').trim() || `step_${index}`
  const id = (step.id ?? '').trim() || `step_${index}`
  const onFailure = step.on_failure !== undefined && FAILURE_MODES.has(step.on_failure)
    ? step.on_failure
    : undefined
  return {
    id,
    tool,
    depends_on: step.depends_on,
    parallel_group: step.parallel_group ?? null,
    on_failure: onFailure,
    retry: sanitizeRetry(step.retry),
    rollback: step.rollback ?? null,
  }
}

/** Validate and normalize a procedure input into a typed, safe shape. */
export function normalizeProcedure(input: ProcedureInput): NormalizedProcedure {
  const rawSteps = input.steps ?? []
  const seeds = rawSteps.map(toSeed)
  // Reject references to steps that do not exist (defensive), then freeze into
  // the readonly ProceduralStep shape.
  const ids = new Set(seeds.map(s => s.id))
  const steps: ProceduralStep[] = seeds.map(s => ({
    id: s.id,
    tool: s.tool,
    depends_on: s.depends_on === undefined ? undefined : s.depends_on.filter(d => ids.has(d)),
    parallel_group: s.parallel_group,
    on_failure: s.on_failure,
    retry: s.retry,
    rollback: s.rollback,
  }))
  const preconditions = input.preconditions?.map(p => p.trim()).filter(Boolean) ?? []
  const tool_chain = steps.map(s => s.tool)
  return {
    steps,
    preconditions,
    tool_chain,
    success_rate: input.success_rate !== undefined
      ? Math.min(1, Math.max(0, input.success_rate))
      : undefined,
  }
}

/**
 * Backward-compatible extraction of procedural steps from a P0-era `content`
 * string whose lines look like numbered/Markdown-styled steps. Returns `[]`
 * when the content holds no step-like lines, so non-procedural facts pass
 * through unchanged.
 */
export function stepsFromContent(content: string): ProceduralStep[] {
  const lines = content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  const stepLines = lines.filter(l => /^\s*(?:[-*]|\d+[.)]|##?\s+)\s*\S/.test(l))
  if (stepLines.length < 2) return []
  return stepLines.map((line, index) => {
    const text = line.replace(/^\s*(?:[-*]|\d+[.)]|##?\s+)\s*/, '').trim()
    // A trailing parenthetical `(tool: xxx)` or `(rollback: yyy)` may encode
    // tool/rollback hints from richer extractions.
    const toolMatch = text.match(/\(tool:\s*([^)]+)\)/)
    const rollbackMatch = text.match(/\(rollback:\s*([^)]+)\)/)
    const clean = text.replace(/\(tool:\s*[^)]+\)/, '').replace(/\(rollback:\s*[^)]+\)/, '').trim()
    return {
      id: `step_${index}`,
      tool: toolMatch?.[1]?.trim() ?? clean,
      rollback: rollbackMatch?.[1]?.trim() ?? null,
    }
  })
}
