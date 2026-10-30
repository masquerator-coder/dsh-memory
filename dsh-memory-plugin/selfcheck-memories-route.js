/**
 * End-to-end check of the `/dsh-memory/memories` and `/dsh-memory/health`
 * routes: what the settings page receives when a new project becomes the live
 * session, and what an operator sees when digest generation has been failing.
 *
 * Drives the real `apply` with stub host services (including a `webServer`
 * that records the registered route) and a stubbed bridge whose `memory.list`
 * honours the project scope the way `bridge.py` does. Python is unnecessary
 * here: the assertion is about which scope the *host* asks for and what extra
 * fields it ships back, not about SQL.
 *
 * Run: node dsh-memory-plugin/selfcheck-memories-route.js
 */
import { BridgeClient } from './bridge.js'
import { apply } from './index.js'

let failures = 0
/** @param {boolean} condition - what must hold. @param {string} label - what was checked. */
function check(condition, label) {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.error(`FAIL  ${label}`)
}

/** Five memories in project alpha, two in beta. */
const STORE = {
  'c-work-alpha': Array.from({ length: 5 }, (_, i) => ({ summary: `alpha ${i}` })),
  'c-work-beta': Array.from({ length: 2 }, (_, i) => ({ summary: `beta ${i}` })),
}

const ROUTES = new Map()
const calls = []

/** What `/health` reads: one failed attempt, then a clean one. */
let HISTORY = [
  {
    digest_id: 'dg_bad',
    status: 'error',
    reason: 'auto',
    error: '模型调用失败：400: MissingSessionID',
    created_at: '2026-10-28T08:41:30+00:00',
  },
]

const stub = {
  get(name) {
    return ['tools', 'systemPrompt', 'agents', 'webServer'].includes(name) ? {} : undefined
  },
  effect(fn) {
    const dispose = fn()
    return () => dispose?.()
  },
  on() {},
  tools: { register() {} },
  // The HTTP routes live behind `ctx.inject(['webServer'], …)`: the stub runs
  // the callback immediately with a context that offers the same surface.
  inject(deps, callback) {
    if (typeof callback !== 'function') return
    const wanted = Array.isArray(deps) ? deps : [deps]
    if (wanted.includes('webServer')) callback(stub)
  },
  logger: { info() {}, warn() {}, error() {} },
  systemPrompt: { section() { return () => {} } },
  webServer: {
    register({ path, handler }) {
      ROUTES.set(path, handler)
      return () => ROUTES.delete(path)
    },
  },
}

BridgeClient.prototype.ensureChild = async () => null
BridgeClient.prototype.call = async (command, payload = {}) => {
  calls.push({ command, payload })
  if (command === 'projects') return { project_id: payload.cwd === 'C:/work/alpha' ? 'c-work-alpha' : 'c-work-beta' }
  if (command === 'memory.list') {
    const project = payload.all_projects ? null : (payload.project_id ?? 'unknown')
    const items = project
      ? (STORE[project] ?? [])
      : Object.values(STORE).flat()
    return { items, total: items.length, project_id: project ?? null }
  }
  if (command === 'status') {
    return {
      home: 'C:/mem/memory.db',
      project_id: 'c-work-alpha',
      memories: 7,
      // `status.digest` is the latest *successful* digest: health must not use
      // it to answer "did the last run work?".
      digest: { digest_id: 'dg_ok', status: 'ok' },
      stats: { maintenance: { due: ['decay'] } },
    }
  }
  if (command === 'digest.history') return { items: HISTORY }
  return {}
}

apply(stub, {})

/**
 * Send one request through a registered route.
 *
 * Every route is behind the per-process write token now (see
 * `requestRejection`), so this performs the same handshake the settings page
 * does and replays the token as a header.
 *
 * @param {string} path - route path.
 * @param {object} payload - JSON body.
 * @returns {Promise<any>} the `result` field.
 */
async function routeTo(path, payload) {
  const handler = ROUTES.get(path)
  if (!handler) throw new Error(`the ${path} route was not registered`)
  const token = await handshake()
  const listeners = new Map()
  const req = {
    method: 'POST',
    url: path,
    headers: { host: '127.0.0.1:58586', 'x-dsh-memory-token': token },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return req
    },
    resume() {},
  }
  const res = {
    statusCode: 0,
    headersSent: false,
    _body: '',
    writeHead(status) { this.statusCode = status; this.headersSent = true; return this },
    end(chunk) { if (chunk) this._body += String(chunk) },
  }
  handler(req, res)
  const raw = Buffer.from(JSON.stringify(payload), 'utf8')
  for (const fn of listeners.get('data') ?? []) fn(raw)
  for (const fn of listeners.get('end') ?? []) fn()
  // `jsonRoute` answers from a promise chain: let it settle.
  for (let i = 0; i < 50 && !res._body; i += 1) await new Promise((r) => setTimeout(r, 5))
  const envelope = JSON.parse(res._body)
  if (!envelope.ok) throw new Error(`route rejected: ${JSON.stringify(envelope.error)}`)
  return envelope.result
}

/** The write token, minted by the host and fetched once. */
let cachedToken = null

/**
 * Fetch the token from the handshake route.
 * @returns {Promise<string>} the current token.
 */
async function handshake() {
  if (cachedToken !== null) return cachedToken
  const handler = ROUTES.get('/dsh-memory/token')
  if (!handler) throw new Error('the token route was not registered')
  const res = {
    statusCode: 0,
    _body: '',
    writeHead(status) { this.statusCode = status; return this },
    end(chunk) { if (chunk) this._body += String(chunk) },
  }
  handler({ method: 'GET', url: '/dsh-memory/token', headers: { host: '127.0.0.1:58586' } }, res)
  const envelope = JSON.parse(res._body)
  if (!envelope.ok) throw new Error('the token handshake was refused')
  cachedToken = String(envelope.result.token)
  return cachedToken
}

/** POST to the memories route. */
const route = (payload) => routeTo('/dsh-memory/memories', payload)

console.log('scoped request still lists one project')
{
  const result = await route({ all_projects: false, project_id: 'c-work-alpha', limit: 20, offset: 0 })
  check(result.total === 5, `narrowing to alpha returns its 5 entries (got ${result.total})`)
  check(result.scoped_to_project === true, 'the response says which project it is scoped to')
  check(result.project_id === 'c-work-alpha', 'and names it')
}

console.log('unscoped request spans every project')
{
  const result = await route({ all_projects: true, limit: 20, offset: 0 })
  check(result.total === 7, `all projects returns 5 + 2 = 7 entries (got ${result.total})`)
  check(result.scoped_to_project === false, 'the response marks itself unscoped')
  const listCall = calls.filter((c) => c.command === 'memory.list').at(-1)
  check(listCall.payload.all_projects === true && listCall.payload.project_id === undefined,
    'the bridge is asked with all_projects and no project id')
}

console.log('a scoped request the host cannot resolve is announced, not silent')
{
  const before = calls.length
  const result = await route({ all_projects: false, limit: 20, offset: 0 })
  check(calls.length > before, 'the bridge was still called')
  check(result.scoped_to_project === false, 'the response is not presented as a project listing')
  check(result.scope_note === 'no-live-session', `it explains why (got ${JSON.stringify(result.scope_note)})`)
}

console.log('health reports a failed digest instead of a blanket ok')
{
  const result = await routeTo('/dsh-memory/health', {})
  check(result.ok === false, 'a failed digest attempt makes health unhealthy')
  check(result.problems?.[0]?.kind === 'digest', 'the problem names the digest')
  check(result.digest?.last_attempt?.status === 'error', 'the last attempt is reported, not the latest success')
  check(result.digest?.latest?.digest_id === 'dg_ok', 'the latest successful digest is still visible')
  check(result.maintenance?.due?.[0] === 'decay', 'due maintenance tasks are surfaced')
}
{
  HISTORY = [{ digest_id: 'dg_ok', status: 'ok', reason: 'manual', created_at: '2026-10-28T09:00:00+00:00' }]
  const result = await routeTo('/dsh-memory/health', {})
  check(result.ok === true, 'a clean last attempt keeps health ok')
  check((result.problems ?? []).length === 0, 'and reports no problems')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
process.exit(0)