/* Read-only audit reproduction. Creates no repo artifacts; in-memory store only. */
import { Config } from '../../src/config.ts'
import { buildPolicy } from '../../src/build-policy.ts'
import { JsonFileMemoryRepository } from '../../src/infrastructure/json-repo.ts'
import { EntityResolver } from '../../src/domain/entity.ts'
import { MemoryService } from '../../src/service.ts'
import { qualifierSignature } from '../../src/domain/semantic-key.ts'
import { parseTtlMs } from '../../src/domain/policies.ts'
import { rememberOne } from '../../src/application/remember.ts'

const line = (s: string) => console.log(s)
const check = (label: string, cond: boolean) => line(`${cond ? 'CONFIRMED' : 'not-repro'}  ${label}`)

const policy = buildPolicy(Config({}))

// ---------- (c) nested qualifier dropped from identity ----------
const nested = qualifierSignature('episodic', { time: { event_time: '2026-09-05T14:30:00Z' } } as never)
const empty = qualifierSignature('episodic', undefined)
const flat = qualifierSignature('episodic', { event_time: '2026-09-05T14:30:00Z' } as never)
line(`\n[c] nestedSig=${nested.slice(0, 12)} noneSig=${empty.slice(0, 12)} flatSig=${flat.slice(0, 12)}`)
check('nested event_time collapses to the no-qualifier signature', nested === empty)
check('flat event_time DOES change the signature', flat !== empty)

// ---------- (d) TTL whitespace -> instant expiry ----------
line(`\n[d] parseTtlMs('   ')=${parseTtlMs('   ')} parseTtlMs('365 days')=${parseTtlMs('365 days')} parseTtlMs('-100')=${parseTtlMs('-100')}`)
check("blank TTL becomes 0ms (fact expires instantly)", parseTtlMs('   ') === 0)
check('negative numeric TTL is accepted', (parseTtlMs('-100') ?? 0) < 0)

// ---------- (e) nil: entity id ignores entity type ----------
const resolver = new EntityResolver()
const ua = resolver.resolve('Alice', { type: 'user' })
const pa = resolver.resolve('Alice', { type: 'project' })
line(`\n[e] user:Alice -> ${ua.id} | project:Alice -> ${pa.id}`)
check('different entity types share the same nil: id', ua.id === pa.id)

// ---------- (b) service-level: in-memory store ----------
const repo = new JsonFileMemoryRepository()
await repo.open()
const svc = new MemoryService({
  repo,
  resolver,
  policy: () => policy,
  llmExtractionEnabled: false,
  captureEnabled: true,
})

// (a) cross-scope conflict resolution
const A = await svc.remember({ content: 'Alice 偏好素食', scope: 'session:A', predicate: 'prefers_diet' })
const B = await svc.remember({ content: 'Alice 偏好素食', scope: 'session:B', predicate: 'prefers_diet' })
const aAfter = await repo.get(A.stored.id)
const aRecall = await svc.recall({ query: '素食', scope: 'session:A' })
line(`\n[a] B.superseded=${B.superseded ?? 'undefined'} | A.status=${aAfter?.status} | recall(session:A).length=${aRecall.length}`)
check('a write in session B superseded session A fact', B.superseded === A.stored.id)
check('session A can no longer recall its own fact', aRecall.length === 0)

// (g) PII facts are returned by recall verbatim
await svc.remember({
  content: '我的手机号 13800138000 和身份证 110105199003078272',
  scope: 's-pii',
  predicate: 'stated',
  pii: true,
})
const piiHits = await svc.recall({ query: '手机号', scope: 's-pii' })
line(`[g] pii recall hits=${piiHits.length} content=${JSON.stringify(piiHits[0]?.fact.content)}`)
check('PII-flagged fact is returned verbatim to the model-facing path', piiHits.length === 1)

// (h) user.md round-trip is not a no-op for facts the view cannot show
await svc.remember({ content: 'Alice 偏好素食', scope: 's-md', predicate: 'prefers_diet', confidence: 0.9 })
await svc.remember({ content: 'Alice 的手机号 13800138000', scope: 's-md', predicate: 'stated', pii: true })
await svc.remember({
  content: '项目部署在阿里云 ACK',
  scope: 's-md',
  predicate: 'deployed_on',
  subject: { type: 'project', name: 'demo', id: 'project:demo' },
})
const before = (await repo.listScope('s-md')).filter(f => f.status === 'active').length
const rendered = await svc.renderUserMd('s-md')
const report = await svc.applyUserMdEdits('s-md', rendered)
const after = (await repo.listScope('s-md')).filter(f => f.status === 'active').length
line(`\n[h] rendered lines=${rendered.split('\n').filter(l => l.startsWith('- ')).length} active before=${before}`)
line(`    render+apply(unchanged view) -> added=${report.added} superseded=${report.superseded} archived=${report.archived}`)
line(`    active after=${after}`)
check('a no-op re-save of the rendered view archives facts', report.archived > 0)

// ---------- (i) research profile reached through the real config schema ----------
const researchPolicy = buildPolicy(Config({ profile: 'research' }))
line(`\n[i] schema-validated research: versions=${researchPolicy.retrieval.versions} fanout=${researchPolicy.retrieval.graph.maxFanoutPerEntity} ttl=${researchPolicy.forgetting.semantic.ttl} filter=${researchPolicy.privacy.retrievalFilter.join(',')}`)
check(
  'research profile is inert once config passes through the schema',
  researchPolicy.retrieval.versions === 'active' && researchPolicy.forgetting.semantic.ttl === '365d',
)

// ---------- (j) concurrent same-key writes ----------
const raw = (scope: string) => ({
  subject: { type: 'user', name: '用户' },
  predicate: 'prefers_diet',
  object: { type: 'concept', name: 'x' },
  content: 'x',
  scope,
})
const repo2 = new JsonFileMemoryRepository()
await repo2.open()
const deps = { repo: repo2, resolver, forgetting: policy.forgetting, defaultPrivacy: policy.privacy.default }
await Promise.all([rememberOne(deps, raw('s-race') as never), rememberOne(deps, raw('s-race') as never)])
const actives = (await repo2.listScope('s-race')).filter(f => f.status === 'active')
line(`\n[j] concurrent same-key writes -> active facts=${actives.length} versions=${actives.map(f => f.version).join(',')}`)
check('concurrent identical assertions both stay active', actives.length === 2)

// ---------- (k) capture path persists even a message with no memory signal ----------
const { ScopeQueue } = await import('../../src/infrastructure/queue.ts')
const queue = new ScopeQueue()
const repo3 = new JsonFileMemoryRepository()
await repo3.open()
const svc3 = new MemoryService({
  repo: repo3,
  resolver,
  policy: () => policy,
  queue,
  llmExtractionEnabled: false,
  captureEnabled: true,
})
// No trigger phrase, no number/date/proper noun (§6.4 mode B pattern).
const chatty = '今天天气不错，帮我把说明文档的那一节改一下，顺便看看排版'
const accepted = svc3.extractAndRemember({ text: chatty, scope: 's-cap' }).accepted
await queue.whenDrained('s-cap')
const captured = (await repo3.listScope('s-cap')).filter(f => f.status === 'active')
line(`\n[k] accepted=${accepted} | facts stored from one ordinary chat message = ${captured.length}`)
check('an ordinary message with no trigger word is persisted as a fact', captured.length === 1)

// ---------- (l) unhealthy backend is skipped but the fact is marked ready ----------
const { OutboxJournal } = await import('../../src/infrastructure/outbox-journal.ts')
const { IndexWorker } = await import('../../src/application/index-worker.ts')
const backend = (name: string, ok: boolean) => {
  const store = new Map<string, unknown>()
  const b = {
    name,
    capabilities: { search: name === 'vector', graph: name === 'graph' },
    healthy: ok,
    health: () => ({ ok: b.healthy, detail: b.healthy ? undefined : 'down' }),
    upsert: async (f: { id: string }) => { if (!b.healthy) throw new Error('down'); store.set(f.id, f) },
    remove: async (id: string) => { store.delete(id) },
    search: async () => [],
    graphNeighbors: async () => [],
    graphFactIds: async () => [],
    count: async () => store.size,
    has: (id: string) => store.has(id),
  }
  return b
}
const repo4 = new JsonFileMemoryRepository()
await repo4.open()
const outbox = new OutboxJournal()
const vHealthy = backend('vector', true)
const vDown = backend('mirror', false)
const worker = new IndexWorker({ repo: repo4, outbox, backends: [vHealthy, vDown] as never })
const written = await svcWrite(repo4, resolver, policy, 's-idx')
await repo4.put({ ...written, index_state: 'pending_indexing' } as never)
await outbox.append('index', written.id, 's-idx')
const r1 = await worker.tick()
const afterTick = await repo4.get(written.id)
vDown.healthy = true
const r2 = await worker.tick()
line(`\n[l] tick1 skippedUnhealthy=${r1.skippedUnhealthy} indexed=${r1.indexed} | fact.index_state=${afterTick?.index_state} | outbox.total=${(await outbox.stats()).total}`)
line(`    healthy backend has fact=${vHealthy.has(written.id)} | recovered backend has fact=${vDown.has(written.id)} | tick2.attempted=${r2.attempted}`)
check('fact is marked ready although one backend never received it', afterTick?.index_state === 'ready' && !vDown.has(written.id))
check('the missing index is never retried after the backend recovers', r2.attempted === 0)

async function svcWrite(r: JsonFileMemoryRepository, res: EntityResolver, pol: typeof policy, scope: string) {
  const d = { repo: r, resolver: res, forgetting: pol.forgetting, defaultPrivacy: pol.privacy.default }
  const out = await rememberOne(d, {
    subject: { type: 'user', name: '用户' },
    predicate: 'prefers_diet',
    object: { type: 'concept', name: '素食' },
    content: 'Alice 偏好素食',
    scope,
  } as never)
  return out.stored
}
