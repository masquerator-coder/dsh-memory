/**
 * JSON-file memory repository — the default, dependency-free store for P0.
 *
 * Main records + derived indexes (semantic_key, scope, entity adjacency) live
 * in one on-disk JSON document, atomically replaced on each write (temp file +
 * rename) so a crash never leaves a half-written facts file. Recall relevance
 * is a small BM25-style lexical score over content/entities/tags — the pure-JS
 * stand-in for a vector store until an embedding provider is plugged in.
 *
 * All mutations are serialized through an internal promise chain so concurrent
 * callers (fast channel + background extractor) never interleave a partial
 * read-modify-write.
 *
 * @module dsh-memory/infrastructure/json-repo
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AtomicFact } from '../domain/fact.ts'
import { factAllowed } from '../application/privacy.ts'
import type {
  FactFilter,
  MemoryRepository,
  RecallCandidate,
  StoreStats,
} from '../application/ports.ts'

interface DocumentState {
  facts: Record<string, AtomicFact>
}

interface TokenIndex {
  /** term → Set of fact ids that contain it (lexical search). */
  df: ReadonlyMap<string, ReadonlySet<string>>
  /** fact id → Map of term → within-doc term frequency. */
  tfs: ReadonlyMap<string, ReadonlyMap<string, number>>
  total: number
}

/** Split text into lowercase alphanumeric terms (CJK kept as single chars). */
function tokenize(text: string): string[] {
  const cjkRe = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g
  const cjk = text.match(cjkRe) ?? []
  const ascii = (text.replace(cjkRe, ' ').toLowerCase().match(/[a-z0-9]+/g) ?? [])
  return [...ascii, ...cjk]
}

/** Available fact fields used for lexical search, weighted by importance. */
function factText(fact: AtomicFact): string {
  return [
    fact.content,
    fact.subject.name,
    fact.object?.name ?? '',
    fact.tags?.join(' ') ?? '',
    fact.subject.id,
  ].join(' ')
}

function applyFilter(fact: AtomicFact, filter: FactFilter): boolean {
  // One shared gate with the recall engine (application/privacy), so the store
  // and the engine can never disagree about what a recall may surface.
  return factAllowed(fact, filter)
}

/** BM25 term weight for one query term over the collection. */
class Bm25Index {
  private readonly df: Map<string, Set<string>> = new Map()
  private readonly tfs: Map<string, Map<string, number>> = new Map()
  private total = 0

  add(factId: string, fact: AtomicFact): void {
    const terms = new Map<string, number>()
    for (const term of tokenize(factText(fact))) terms.set(term, (terms.get(term) ?? 0) + 1)
    const tf = new Map<string, number>()
    for (const [term, count] of terms) {
      tf.set(term, count)
      let set = this.df.get(term)
      if (set === undefined) {
        set = new Set()
        this.df.set(term, set)
      }
      set.add(factId)
    }
    this.tfs.set(factId, tf)
    this.total += 1
  }

  remove(factId: string): void {
    const tf = this.tfs.get(factId)
    if (tf === undefined) return
    for (const term of tf.keys()) {
      const set = this.df.get(term)
      if (set !== undefined) {
        set.delete(factId)
        if (set.size === 0) this.df.delete(term)
      }
    }
    this.tfs.delete(factId)
    if (this.total > 0) this.total -= 1
  }

  score(queryTerms: readonly string[]): Map<string, number> {
    const scores = new Map<string, number>()
    const avgDocLen = Math.max(1, this.total)
    for (const term of queryTerms) {
      const df = this.df.get(term)?.size ?? 0
      if (df === 0) continue
      const idf = Math.log(1 + (this.total - df + 0.5) / (df + 0.5))
      for (const factId of this.df.get(term)!) {
        const tf = this.tfs.get(factId)?.get(term) ?? 0
        const docLen = Math.max(1, this.tfs.get(factId)?.size ?? 0)
        const tfNorm = (tf * 1.5) / (tf + 1.5 * (0.25 + 0.75 * (docLen / avgDocLen)))
        scores.set(factId, (scores.get(factId) ?? 0) + idf * tfNorm)
      }
    }
    // Normalize to [0,1] by the max score observed.
    let max = 0
    for (const v of scores.values()) if (v > max) max = v
    if (max === 0) return scores
    for (const [k, v] of scores) scores.set(k, v / max)
    return scores
  }

  toIndex(): TokenIndex {
    return {
      df: new Map(this.df),
      tfs: new Map(this.tfs),
      total: this.total,
    }
  }

  static fromIndex(index: TokenIndex): Bm25Index {
    const idx = new Bm25Index()
    idx.df.clear()
    for (const [k, v] of index.df) idx.df.set(k, new Set(v))
    for (const [k, v] of index.tfs) idx.tfs.set(k, new Map(v))
    idx.total = index.total
    return idx
  }
}

/** A fact mutation queued for the serialized write chain. */
type Mutation =
  | { readonly kind: 'put'; readonly fact: AtomicFact }
  | { readonly kind: 'delete'; readonly id: string }

/**
 * Why the store could not load its document, and what was done about it. Never
 * silently ignored: an empty in-memory store would overwrite every persisted
 * memory on the first write.
 */
export interface OpenIssue {
  /** `corrupt` = unparsable content; `unreadable` = could not be read at all. */
  readonly kind: 'corrupt' | 'unreadable'
  readonly message: string
  /** Where the unreadable document was preserved, when it could be moved aside. */
  readonly backupPath?: string
}

export class JsonFileMemoryRepository implements MemoryRepository {
  private facts = new Map<string, AtomicFact>()
  private byKey = new Map<string, AtomicFact>()
  private byScope = new Map<string, Set<string>>()
  private adjacency = new Map<string, Set<string>>()
  private bm25 = new Bm25Index()
  private chain: Promise<void> = Promise.resolve()
  private issue: OpenIssue | undefined
  /**
   * Set when the previous document could not be preserved. Writes are refused
   * rather than overwriting data we failed to load.
   */
  private readOnly = false

  /** `filePath` may be omitted for a pure in-memory store (tests). */
  constructor(private readonly filePath?: string) {}

  /** What went wrong at `open()`, if anything (surfaced by the plugin logger). */
  get openIssue(): OpenIssue | undefined {
    return this.issue
  }

  /** Whether writes are refused because the previous document is unpreserved. */
  get isReadOnly(): boolean {
    return this.readOnly
  }

  /**
   * Load an existing document (creates an empty one on first run).
   *
   * A missing file is a normal first run. A *corrupt* or *unreadable* file is
   * quarantined instead of being reported as "empty" — see {@link quarantine}.
   * Never throws for a bad document, so the plugin loader cannot end up with an
   * unhandled rejection and an empty store pointed at good data.
   */
  async open(): Promise<void> {
    if (this.filePath === undefined) return
    let doc: DocumentState = { facts: {} }
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as { facts?: Record<string, AtomicFact> }
      doc = { facts: parsed.facts ?? {} }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') await this.quarantine(error)
    }
    for (const fact of Object.values(doc.facts)) this.addToMemory(fact)
  }

  /**
   * Preserve a document we could not load, so the next write cannot destroy it.
   *
   * Corrupt content is moved aside to `<file>.corrupt-<ts>` (the next write then
   * starts a fresh file while the original bytes remain on disk). A document we
   * could not read at all is left untouched and the store goes read-only.
   */
  private async quarantine(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    if (!(error instanceof SyntaxError)) {
      this.readOnly = true
      this.issue = { kind: 'unreadable', message }
      return
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${this.filePath}.corrupt-${stamp}`
    try {
      await rename(this.filePath!, backupPath)
      this.issue = { kind: 'corrupt', message, backupPath }
    } catch {
      // Could not move it aside — refuse writes instead of overwriting it.
      this.readOnly = true
      this.issue = { kind: 'corrupt', message }
    }
  }

  /**
   * Serialize one mutation behind the previous one. The chain records that an
   * operation finished, never that it failed: `run.then(ok, fail)` would make a
   * single failure (a transient file lock, a full disk) reject *every* later
   * read and write on this repository with a stale error.
   */
  private enqueue(mutation: Mutation): Promise<void> {
    const run = this.chain.then(async () => {
      const id = mutation.kind === 'put' ? mutation.fact.id : mutation.id
      const previous = this.facts.get(id)
      if (mutation.kind === 'put') this.applyPut(mutation.fact)
      else this.applyDelete(mutation.id)
      try {
        await this.persist()
      } catch (error) {
        // Keep memory and disk in step: a write that did not land must not leave
        // a phantom fact (or a phantom deletion) behind in the indexes.
        if (previous === undefined) this.applyDelete(id)
        else this.applyPut(previous)
        throw error
      }
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  private addToMemory(fact: AtomicFact): void {
    this.facts.set(fact.id, fact)
    this.byKey.set(fact.semantic_key, fact) // latest wins by insertion order in map
    let scopeSet = this.byScope.get(fact.scope)
    if (scopeSet === undefined) {
      scopeSet = new Set()
      this.byScope.set(fact.scope, scopeSet)
    }
    scopeSet.add(fact.id)
    this.linkAdjacency(fact, true)
    this.bm25.add(fact.id, fact)
  }

  private linkAdjacency(fact: AtomicFact, add: boolean): void {
    const nodeIds = new Set<string>([fact.subject.id])
    if (fact.object?.id !== undefined) nodeIds.add(fact.object.id)
    for (const node of nodeIds) {
      let set = this.adjacency.get(node)
      if (set === undefined) {
        set = new Set()
        this.adjacency.set(node, set)
      }
      if (add) set.add(fact.id)
      else {
        set.delete(fact.id)
        if (set.size === 0) this.adjacency.delete(node)
      }
    }
  }

  private applyPut(fact: AtomicFact): void {
    const existing = this.facts.get(fact.id)
    if (existing !== undefined) {
      this.byKey.delete(existing.semantic_key)
      this.linkAdjacency(existing, false)
      this.bm25.remove(fact.id)
      this.byScope.get(existing.scope)?.delete(existing.id)
    }
    this.addToMemory(fact)
  }

  private applyDelete(id: string): void {
    const existing = this.facts.get(id)
    if (existing === undefined) return
    this.facts.delete(id)
    this.byKey.delete(existing.semantic_key)
    this.linkAdjacency(existing, false)
    this.bm25.remove(id)
    this.byScope.get(existing.scope)?.delete(existing.id)
  }

  private async persist(): Promise<void> {
    if (this.filePath === undefined) return
    if (this.readOnly) {
      throw new Error(
        'memory: refusing to write — the existing memory document could not be read or preserved (see the plugin log)',
      )
    }
    const doc: DocumentState = { facts: Object.fromEntries(this.facts) }
    const tmp = `${this.filePath}.tmp`
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(tmp, JSON.stringify(doc), 'utf8')
    await rename(tmp, this.filePath)
  }

  put(fact: AtomicFact): Promise<void> {
    return this.enqueue({ kind: 'put', fact })
  }

  delete(id: string): Promise<void> {
    return this.enqueue({ kind: 'delete', id })
  }

  async get(id: string): Promise<AtomicFact | undefined> {
    await this.chain
    return this.facts.get(id)
  }

  async listScope(scope: string): Promise<AtomicFact[]> {
    await this.chain
    const ids = this.byScope.get(scope)
    if (ids === undefined) return []
    return [...ids].map(id => this.facts.get(id)!).filter(Boolean)
  }

  async bySemanticKey(key: string): Promise<AtomicFact[]> {
    await this.chain
    const fact = this.byKey.get(key)
    return fact === undefined ? [] : [fact]
  }

  async latestBySemanticKey(key: string): Promise<AtomicFact | undefined> {
    await this.chain
    return this.byKey.get(key)
  }

  async query(
    filter: FactFilter,
    queryTerms: readonly string[],
    _graphSeedIds: readonly string[],
  ): Promise<RecallCandidate[]> {
    await this.chain
    // Tokenize each incoming term (the caller may pass raw strings or already
    // split terms) so CJK/ascii matching is consistent with the index.
    const terms = [...new Set(queryTerms.flatMap(term => tokenize(term)))]
    const scores = this.bm25.score(terms)
    // When there are no meaningful query terms, fall back to a recency-ish
    // ordering of scope facts so the caller still gets candidates.
    if (scores.size === 0) {
      const scopeFacts = filter.scope !== undefined ? await this.listScope(filter.scope) : [...this.facts.values()]
      return scopeFacts
        .filter(f => applyFilter(f, filter))
        .map(fact => ({ fact, relevance: 0, viaGraph: false }))
    }
    const out: RecallCandidate[] = []
    for (const [factId, score] of scores) {
      const fact = this.facts.get(factId)
      if (fact === undefined || !applyFilter(fact, filter)) continue
      out.push({ fact, relevance: score, viaGraph: false })
    }
    return out
  }

  async neighbors(entityId: string, relationWhitelist: readonly string[]): Promise<readonly string[]> {
    await this.chain
    const factIds = this.adjacency.get(entityId)
    if (factIds === undefined) return []
    const out = new Set<string>()
    for (const id of factIds) {
      const fact = this.facts.get(id)
      if (fact === undefined) continue
      if (relationWhitelist.length > 0 && !relationWhitelist.includes(fact.canonical_predicate)) continue
      if (fact.status !== 'active') continue
      if (fact.subject.id !== entityId) out.add(fact.subject.id)
      if (fact.object?.id !== undefined && fact.object.id !== entityId) out.add(fact.object.id)
    }
    return [...out]
  }

  async byEntity(entityId: string, filter: FactFilter): Promise<AtomicFact[]> {
    await this.chain
    const factIds = this.adjacency.get(entityId)
    if (factIds === undefined) return []
    const out: AtomicFact[] = []
    for (const id of factIds) {
      const fact = this.facts.get(id)
      if (fact === undefined || !applyFilter(fact, filter)) continue
      out.push(fact)
    }
    return out
  }

  async stats(): Promise<StoreStats> {
    await this.chain
    let active = 0
    for (const fact of this.facts.values()) if (fact.status === 'active') active += 1
    return { active, total: this.facts.size }
  }

  /** Public accessor so tests can assert persisted on-disk state. */
  async snapshotFacts(): Promise<AtomicFact[]> {
    await this.chain
    return [...this.facts.values()]
  }
}
