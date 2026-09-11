/**
 * Observability — in-process metrics counters + trace span buffer (design §11,
 * §12.4). Dependency-free and pure so it is unit-testable and deployable in the
 * plugin's single-process local position.
 *
 * - {@link Metrics}: typed counters and latency histograms for the write, recall,
 *   extraction, forgetting, and indexing paths. The service increments these and
 *   exposes a snapshot via `MemoryService.metrics()`.
 * - {@link TraceBuffer}: a bounded ring of recent execution spans carrying an id,
 *   name, duration, outcome, and free-form metadata. It gives the "事件 → 抽取 →
 *   写入 → 冲突 → 索引" end-to-end trail (§12.4) without an external tracing
 *   backend; a real OTEL exporter can consume the same spans later.
 *
 * @module dsh-memory/application/observability
 */

/** Canonical counter names used across the plugin (stable keys for dashboards). */
export const MetricKeys = {
  remember: 'memory.remember',
  recall: 'memory.recall',
  recallTimeout: 'memory.recall.timeout',
  forget: 'memory.forget',
  forgetAll: 'memory.forget_all',
  link: 'memory.link',
  extractAttempt: 'extraction.attempt',
  extractSuccess: 'extraction.success',
  extractFail: 'extraction.fail',
  expired: 'forgetting.expired',
  merged: 'forgetting.merged',
  indexTick: 'index.tick',
  indexApplied: 'index.applied',
  indexDead: 'index.dead',
} as const

export type MetricKey = (typeof MetricKeys)[keyof typeof MetricKeys]

const HISTOGRAM_CAP = 256

/** A bounded histogram for one metric (tracks count + sum for an average). */
interface Histogram {
  readonly values: number[]
}

/** In-process metrics registry: integer counters + latency histograms. */
export class Metrics {
  private readonly counters = new Map<string, number>()
  private readonly latencies = new Map<string, Histogram>()

  incr(name: string, n = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + n)
  }

  /** Record a latency sample (ms) for a metric. */
  record(name: string, ms: number): void {
    let h = this.latencies.get(name)
    if (h === undefined) {
      h = { values: [] }
      this.latencies.set(name, h)
    }
    h.values.push(ms)
    if (h.values.length > HISTOGRAM_CAP) h.values.shift()
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0
  }

  /** Average latency for a metric, or undefined when no samples. */
  avgMs(name: string): number | undefined {
    const h = this.latencies.get(name)
    if (h === undefined || h.values.length === 0) return undefined
    return h.values.reduce((a, b) => a + b, 0) / h.values.length
  }

  /** Immutable snapshot for reporting / serialization. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [k, v] of this.counters) out[k] = v
    for (const [k, h] of this.latencies) {
      if (h.values.length > 0) {
        out[`${k}.count`] = h.values.length
        out[`${k}.sum_ms`] = h.values.reduce((a, b) => a + b, 0)
      }
    }
    return out
  }

  reset(): void {
    this.counters.clear()
    this.latencies.clear()
  }
}

/** One traced span (a unit of execution along the memory pipeline). */
export interface TraceSpan {
  readonly id: string
  readonly name: string
  readonly scope?: string
  readonly factId?: string
  readonly startAt: number
  readonly endAt?: number
  readonly ms?: number
  readonly ok?: boolean
  readonly detail?: string
}

/** Handle returned by {@link TraceBuffer.start}; call {@link finish} to close. */
export interface SpanHandle {
  readonly id: string
  finish(ok: boolean, detail?: string): void
}

/** Bounded ring of recent execution spans (§12.4 end-to-end trail). */
export class TraceBuffer {
  private readonly spans: TraceSpan[] = []
  private seq = 0
  constructor(private readonly capacity = 200, private readonly now: () => number = Date.now) {}

  start(name: string, meta: { scope?: string; factId?: string } = {}): SpanHandle {
    this.seq += 1
    const record: TraceSpan = { id: `span_${this.seq}`, name, startAt: this.now(), ...meta }
    this.spans.push(record)
    if (this.spans.length > this.capacity) this.spans.shift()
    const id = record.id
    return {
      id,
      finish: (ok, detail) => {
        const idx = this.spans.findIndex(s => s.id === id)
        if (idx === -1) return
        const end = this.now()
        this.spans[idx] = {
          ...this.spans[idx],
          endAt: end,
          ms: end - this.spans[idx].startAt,
          ok,
          detail,
        }
      },
    }
  }

  /** Most recent spans, newest first, up to `n`. */
  recent(n = 20): readonly TraceSpan[] {
    return this.spans.slice(-n).reverse()
  }

  get length(): number {
    return this.spans.length
  }
}
