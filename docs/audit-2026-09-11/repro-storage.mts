/* Read-only audit repro for the JSON store: crash/error resilience. Uses ./tmp only.
 * "CONFIRMED" = the defect still reproduces; "not-repro" = the defect is gone. */
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { JsonFileMemoryRepository } from '../../src/infrastructure/json-repo.ts'

const dir = new URL('./tmp/', import.meta.url).pathname.replace(/^\//, '')
await mkdir(dir, { recursive: true })
const check = (label: string, cond: boolean) => console.log(`${cond ? 'CONFIRMED' : 'not-repro'}  ${label}`)
const fact = (id: string) => ({
  id, schema_version: '1.0', semantic_key: `k-${id}`, version: 1,
  subject: { type: 'user', name: 'u', id: 'user:u' }, predicate: 'states', canonical_predicate: 'states',
  object: { type: 'concept', name: 'o', id: `c:${id}` }, content: id, type: 'semantic', status: 'active',
  privacy: 'private', pii: false, confidence: 0.5, scope: 'global', index_state: 'ready',
  created_at: 1, updated_at: 1, expires_at: null, source: { type: 'tool_result', credibility: 0.9 },
  entities: ['user:u'], tags: [],
}) as never

// ---- (1) a corrupt file is quarantined instead of being overwritten ----
const corrupt = `${dir}corrupt.json`
await writeFile(corrupt, '{"facts":{"keep-me":{"id":"keep-me"', 'utf8')
const repo = new JsonFileMemoryRepository(corrupt)
let openError: unknown
try { await repo.open() } catch (e) { openError = e }
console.log(`\n[1] open() on a truncated file threw: ${openError instanceof Error ? openError.constructor.name : 'no'}`)
check('open() rejects on a corrupt document instead of quarantining it', openError instanceof SyntaxError)
check('the corrupt document is reported to the caller', repo.openIssue?.kind !== 'corrupt')
await repo.put(fact('new-fact')).catch(() => undefined)
const onDisk = await readFile(corrupt, 'utf8')
const backups = (await readdir(dir)).filter(f => f.includes('.corrupt-'))
const backupText = backups.length > 0 ? await readFile(`${dir}${backups[0]}`, 'utf8') : ''
console.log(`    live facts: ${Object.keys(JSON.parse(onDisk).facts).join(',')} | quarantine copies: ${backups.join(',') || '(none)'}`)
check('the first write replaced the whole store with an empty document', !backupText.includes('keep-me'))

// ---- (2) one failed write permanently poisons every later operation ----
// Make the parent of the data file a FILE so mkdir/write can never succeed.
const blocker = `${dir}blocker`
await writeFile(blocker, 'not a directory', 'utf8')
const bad = new JsonFileMemoryRepository(`${blocker}/facts.json`)
const err = async (p: Promise<unknown>): Promise<string> =>
  p.then(() => 'ok', (e: Error) => `${(e as NodeJS.ErrnoException).code ?? e.message}`)
const e1 = await err(bad.put(fact('f1')))
const e3 = await err(bad.get('f1'))
const e4 = await err(bad.stats())
console.log(`\n[2] put#1 -> ${e1} | get -> ${e3} | stats -> ${e4}`)
check('a read-only operation still fails after one earlier write error', e3 !== 'ok' || e4 !== 'ok')

// ---- (3) mid-flight crash leaves pending_indexing forever (no reconcile) ----
const pending = `${dir}pending.json`
await writeFile(pending, JSON.stringify({ facts: { 'p-1': { ...fact('p-1'), index_state: 'pending_indexing' } } }), 'utf8')
const repo3 = new JsonFileMemoryRepository(pending)
await repo3.open()
const { OutboxJournal } = await import('../../src/infrastructure/outbox-journal.ts')
const { IndexWorker } = await import('../../src/application/index-worker.ts')
const outbox = new OutboxJournal()
const worker = new IndexWorker({ repo: repo3, outbox, backends: [] })
const report = await worker.tick()
console.log(`\n[3] restarted with a pending_indexing fact; worker tick attempted=${report.attempted}, outbox total=${(await outbox.stats()).total}`)
check('nothing reconciles pending_indexing facts on startup', report.attempted === 0 && (await outbox.stats()).total === 0)

await rm(dir, { recursive: true, force: true })
