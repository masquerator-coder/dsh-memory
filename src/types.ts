/** dsh-memory shared types. Zero dsh dependency. */

export type Layer = 'user' | 'memory'
export type Kind = 'preference' | 'env' | 'lesson' | 'decision' | 'general'
export type Tier = 0 | 1
export type Importance = 1 | 2 | 3 | 4 | 5
export type Epistemic = 'observed' | 'inferred' | 'subjective'

/** One durable fact in the semantic (global) memory store. */
export interface MemoryEntry {
  id: string
  layer: Layer
  kind: Kind
  tier: Tier
  topic: string
  content: string
  importance: Importance
  quality: number
  epistemic: Epistemic
  /** Heat snapshot (informational); decisions recompute fresh from last_accessed + window_freq. */
  heat: number
  created: number
  updated: number
  /** Access time, decoupled from updated: consolidation/edits never masquerade as recall. */
  last_accessed: number
  archived: boolean
  low_quality: boolean
  /** Recall-count sliding window (frequency signal, §4). */
  window_freq: number
  /** Sliding-window start (ms). 0 = never accessed since v3. */
  window_start: number
  /** Soft-archive timestamp (ms). undefined = not archived. */
  archived_at?: number
  /** Provenance: which session wrote it. */
  session_id?: string
}

/** One session-level summary in the episodic store (第一级压缩). */
export interface Episode {
  id: string
  session_id: string
  /** Session end time (ms). */
  ts: number
  /** Session-level summary (L0 condensation product). */
  summary: string
  /** JSON array of tool names used this session. */
  tools_used?: string
  topic: string
  /** Reserved: whether L1 extraction already consumed it (unused in v3). */
  extracted: boolean
  archived: boolean
  archived_at?: number
  created: number
}

export type OpAction = 'add' | 'replace' | 'remove' | 'list'

/** A model-facing write/read op against the semantic store. */
export interface MemoryOp {
  action: OpAction
  layer?: Layer
  kind?: Kind
  tier?: Tier
  topic?: string
  id?: string
  content?: string
  importance?: Importance
  epistemic?: Epistemic
  sessionId?: string
  /** remove: hard-delete when true. */
  force?: boolean
}

export interface MemoryBudget {
  tier0: number
  user: number
  memory: number
}

export interface BudgetUsage {
  user: number
  memory: number
  total: number
  pct: number
}

export interface ApplyResult {
  applied: MemoryOp[]
  rejected: { op: MemoryOp; reason: string }[]
  /** Current active (non-archived) entries after the batch. */
  entries: MemoryEntry[]
  /** true when the batch would exceed the tier-0 budget even after demotion. */
  overflowed: boolean
  /** Ids of entries demoted tier0→tier1 to fit the injection budget this batch. */
  demoted: string[]
  usage: BudgetUsage
}

export interface RecallHit {
  entry: MemoryEntry
  score: number
}

export interface EpisodeHit {
  episode: Episode
  score: number
}

/** Expected time-to-forget (days until heat ≈ 0.05) per kind. user layer is immortal. */
export interface ForgetDays {
  env: number
  lesson: number
  decision: number
  general: number
}
