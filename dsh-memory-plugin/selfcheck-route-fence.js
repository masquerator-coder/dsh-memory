/**
 * End-to-end check of the `/dsh-memory/*` request fence: which callers are let
 * through and which are refused.
 *
 * The loopback + Origin rules stop a web page, but a program running as the
 * same user satisfies them trivially (it writes its own headers). The
 * per-process write token is what makes a call deliberate, so this file pins
 * both halves of the behaviour:
 *
 *   - a caller that performs the handshake and replays the token is accepted;
 *   - a caller that reaches the port with no token, a wrong token, or a copied
 *     token on another host is refused;
 *   - the handshake itself is refused cross-site, so a page cannot mint one.
 *
 * The last group is the one that matters most: a token check that never
 * rejects anything would look identical to no check at all.
 *
 * Run: node dsh-memory-plugin/selfcheck-route-fence.js
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

const ROUTES = new Map()
const MEM = { content: '', mode: 'vector', updated_at: null }

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
  if (command === 'projects') return { project_id: 'c-work-alpha' }
  if (command === 'digest.anchor') return { text: '@@dsh-memory 1\n@@', summary: {}, profile: null }
  if (command === 'instruction.read') {
    return { content: MEM.content, enabled: true, updated_at: MEM.updated_at, max_chars: 4000, chars: MEM.content.length }
  }
  if (command === 'instruction.write') {
    if (payload.content !== undefined) MEM.content = String(payload.content)
    return { content: MEM.content, enabled: true, updated_at: MEM.updated_at, chars: MEM.content.length, max_chars: 4000 }
  }
  return {}
}

apply(stub, {})

/**
 * Drive one registered route with full control over the headers.
 * @param {string} path - route path.
 * @param {object} [options] - `headers` override, `body` payload.
 * @returns {Promise<{status: number, envelope: any}>} the response.
 */
async function raw(path, options = {}) {
  const handler = ROUTES.get(path)
  if (!handler) throw new Error(`the ${path} route was not registered`)
  const listeners = new Map()
  const body = options.body ?? {}
  const req = {
    method: options.method ?? 'POST',
    url: options.url ?? path,
    headers: { host: '127.0.0.1:55497', ...(options.headers ?? {}) },
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
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8')
  for (const fn of listeners.get('data') ?? []) fn(rawBody)
  for (const fn of listeners.get('end') ?? []) fn()
  for (let i = 0; i < 50 && !res._body; i += 1) await new Promise((r) => setTimeout(r, 5))
  return { status: res.statusCode, envelope: JSON.parse(res._body) }
}

/** The real token, as a browser on this machine would obtain it. */
const handshake = await raw('/dsh-memory/token', { method: 'GET' })
check(handshake.status === 200 && handshake.envelope?.ok === true, 'a same-site reader can fetch the token')
const TOKEN = String(handshake.envelope?.result?.token ?? '')
check(TOKEN.length >= 16, 'the token is a long random value')
check(
  handshake.envelope?.result?.token === TOKEN && !('message' in (handshake.envelope?.result ?? {})),
  'the handshake hands back the token and nothing else sensitive',
)

console.log('\nthe token is required, and a wrong one is refused')
{
  const none = await raw('/dsh-memory/instruction', { body: { content: 'x' } })
  check(none.status === 403, 'no token at all is refused with 403')
  check(none.envelope?.ok === false, 'and the body says so')

  const wrong = await raw('/dsh-memory/instruction', {
    body: { content: 'x' },
    headers: { 'x-dsh-memory-token': 'not-the-token' },
  })
  check(wrong.status === 403, 'a wrong token is refused with 403')

  const empty = await raw('/dsh-memory/instruction', {
    body: { content: 'x' },
    headers: { 'x-dsh-memory-token': '' },
  })
  check(empty.status === 403, 'an empty token is refused with 403')

  const unrelated = await raw('/dsh-memory/status', { body: {} })
  check(unrelated.status === 403, 'the refusal covers GET-style routes too')
}

console.log('\nthe right token is accepted')
{
  const ok = await raw('/dsh-memory/instruction', {
    url: '/dsh-memory/instruction?token=' + encodeURIComponent(TOKEN),
    body: { content: 'a lasting instruction' },
  })
  check(ok.status === 200 && ok.envelope?.ok === true, 'a token in the query is accepted')
  check(MEM.content === 'a lasting instruction', 'and the write actually landed')
}

console.log('\nboth carriers work, and only the real token counts')
{
  const viaHeader = await raw('/dsh-memory/instruction', {
    body: { content: 'header path' },
    headers: { 'x-dsh-memory-token': TOKEN },
  })
  check(viaHeader.status === 200 && MEM.content === 'header path', 'a token in the header is accepted')

  const badQuery = await raw('/dsh-memory/instruction', {
    url: '/dsh-memory/instruction?token=nope',
    body: { content: 'evil' },
  })
  check(badQuery.status === 403, 'a wrong token in the query is refused')
  check(MEM.content === 'header path', 'and it did not overwrite anything')
}

console.log('\nthe loopback fence still applies on top of the token')
{
  const remoteHost = await raw('/dsh-memory/instruction', {
    body: {},
    headers: { host: '10.0.0.5:55497', 'x-dsh-memory-token': TOKEN },
  })
  check(remoteHost.status === 403, 'a non-loopback Host is refused even with the token')

  const crossSite = await raw('/dsh-memory/instruction', {
    body: {},
    headers: { origin: 'http://evil.test', 'sec-fetch-site': 'cross-site', 'x-dsh-memory-token': TOKEN },
  })
  check(crossSite.status === 403, 'a cross-site Origin is refused even with the token')

  const otherPort = await raw('/dsh-memory/instruction', {
    body: {},
    headers: { origin: 'http://127.0.0.1:6666', 'x-dsh-memory-token': TOKEN },
  })
  check(otherPort.status === 403, 'an Origin on another port is refused even with the token')
}

console.log('\nthe handshake cannot be claimed cross-site')
{
  const stolen = await raw('/dsh-memory/token', {
    method: 'GET',
    headers: { origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' },
  })
  check(stolen.status === 403, 'a cross-site page cannot mint a token')

  const wrongOrigin = await raw('/dsh-memory/token', {
    method: 'GET',
    headers: { origin: 'http://evil.test' },
  })
  check(wrongOrigin.status === 403, 'an Origin naming another host cannot mint a token')

  const sameOrigin = await raw('/dsh-memory/token', {
    method: 'GET',
    headers: { origin: 'http://127.0.0.1:55497' },
  })
  check(sameOrigin.status === 200, 'the settings page itself can')

  const remote = await raw('/dsh-memory/token', {
    method: 'GET',
    headers: { host: '192.168.1.20:55497' },
  })
  check(remote.status === 403, 'a non-loopback Host cannot mint a token')
}

console.log('\nthe token is stable for the life of the process')
{
  const again = await raw('/dsh-memory/token', { method: 'GET' })
  check(again.envelope?.result?.token === TOKEN, 'a second handshake returns the same token')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')