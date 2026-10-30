/**
 * End-to-end check of the `/dsh-memory/instruction` route: what the settings
 * page receives, that saving is visible on the next prompt assembly, and that
 * flipping the switch never destroys the stored text.
 *
 * Drives the real `apply` with stub host services (including a `webServer` that
 * records the registered route) and a stubbed bridge that keeps the instruction
 * in a module-level box the way `bridge.py`'s `meta` table does. Python is
 * unnecessary here: the assertion is about what the *host* asks for, what it
 * ships back, and what the section then renders.
 *
 * Run: node dsh-memory-plugin/selfcheck-instruction-route.js
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

/** The store the stubbed bridge keeps the instruction in. */
const STORE = { content: '', enabled: false, updated_at: null }
const MAX = 4000

const ROUTES = new Map()
const calls = []
const sections = new Map()

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
  systemPrompt: {
    section({ name, text }) {
      sections.set(name, text)
      return () => {}
    },
  },
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
  if (command === 'projects') return { project_id: 'c-work-alpha' }
  if (command === 'digest.anchor') return { text: '@@dsh-memory 1\n@@', summary: {}, profile: null }
  if (command === 'memory.list') return { items: [] }
  if (command === 'instruction.read') {
    return { content: STORE.content, enabled: STORE.enabled, updated_at: STORE.updated_at, max_chars: MAX, chars: STORE.content.length }
  }
  if (command === 'instruction.write') {
    // Mirrors `cmd_instruction_write`: an absent key is "no change".
    if (payload.content !== undefined) {
      const text = String(payload.content).trim()
      if (text.length > MAX) {
        const error = new Error(`instruction is ${text.length} chars; limit is ${MAX}`)
        error.code = 'validation'
        throw error
      }
      STORE.content = text
      STORE.updated_at = '2026-10-30T00:00:00+00:00'
    }
    if (payload.enabled !== undefined) STORE.enabled = payload.enabled === true
    return { content: STORE.content, enabled: STORE.enabled, updated_at: STORE.updated_at, chars: STORE.content.length, max_chars: MAX }
  }
  return {}
}

apply(stub, {})

/**
 * Send one request through a registered route.
 *
 * Every route except the token handshake now demands the per-process write
 * token (see `requestRejection`), so this helper performs the same handshake
 * the settings page does and replays the token as a header. Building requests
 * without it is exactly what the fence is meant to reject.
 *
 * @param {string} path - route path.
 * @param {object} [payload] - JSON body; `undefined` sends a GET-like request.
 * @param {object} [headerOverrides] - extra/overriding headers, for the
 *   rejection cases.
 * @returns {Promise<any>} the `result` field.
 */
async function routeTo(path, payload, headerOverrides) {
  const handler = ROUTES.get(path)
  if (!handler) throw new Error(`the ${path} route was not registered`)
  const token = payload === undefined && path === '/dsh-memory/token'
    ? undefined
    : await handshake()
  const listeners = new Map()
  const req = {
    method: payload === undefined ? 'GET' : 'POST',
    url: path,
    headers: {
      host: '127.0.0.1:58586',
      ...(token === undefined ? {} : { 'x-dsh-memory-token': token }),
      ...(headerOverrides ?? {}),
    },
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
  const raw = Buffer.from(JSON.stringify(payload ?? {}), 'utf8')
  for (const fn of listeners.get('data') ?? []) fn(raw)
  for (const fn of listeners.get('end') ?? []) fn()
  for (let i = 0; i < 50 && !res._body; i += 1) await new Promise((r) => setTimeout(r, 5))
  const envelope = JSON.parse(res._body)
  if (!envelope.ok) {
    const error = new Error(envelope.error?.message ?? 'route rejected')
    error.code = envelope.error?.code
    throw error
  }
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

/** POST to the instruction route. */
const route = (payload) => routeTo('/dsh-memory/instruction', payload)

/** What the instruction section renders right now. */
const renderSection = () => {
  const text = sections.get('dsh-memory:instruction')
  return typeof text === 'function' ? text({}) : ''
}

console.log('a fresh store reads as empty and off')
{
  const result = await route({})
  check(result.content === '', 'nothing written yet reads as an empty instruction')
  check(result.enabled === false, 'and as switched off')
  check(result.max_chars === MAX, 'the ceiling comes from the host')
  check(renderSection() === '', 'an empty, switched-off instruction registers no prompt text')
}

console.log('saving text and switching on makes it resident')
{
  const result = await route({ content: '- 先给结论', enabled: true })
  check(result.content === '- 先给结论', 'the saved text is echoed back')
  check(result.enabled === true, 'and the switch state too')
  // The route re-reads the host-side slot, so the very next assembly sees it
  // instead of waiting out the 15s TTL.
  check(renderSection() === '- 先给结论', 'the section renders the new text immediately')
}

console.log('switching off keeps the text but stops injecting it')
{
  await route({ enabled: false })
  // No `content` key at all in the payload: a toggle must not resend, and
  // therefore cannot overwrite, whatever the textarea holds.
  const write = calls.filter((c) => c.command === 'instruction.write').at(-1)
  check(write.payload.content === undefined, 'the toggle sends no content')
  const read = await route({})
  check(read.content === '- 先给结论', 'the stored text survives the switch-off')
  check(read.enabled === false, 'the switch is off')
  check(renderSection() === '', 'and the section stops rendering it')
}

console.log('switching back on restores exactly the saved text')
{
  await route({ enabled: true })
  check(renderSection() === '- 先给结论', 'the same text comes back without retyping')
}

console.log('the host refuses text over the ceiling')
{
  let rejected = null
  try {
    await route({ content: 'x'.repeat(MAX + 1) })
  } catch (error) {
    rejected = error
  }
  check(rejected !== null, 'an over-long instruction is rejected')
  check(rejected?.code === 'validation', 'as a validation error, not a silent truncation')
  check(renderSection() === '- 先给结论', 'the rejected write left the previous text in place')
}

console.log('clearing the text is explicit')
{
  await route({ content: '' })
  check(renderSection() === '', 'an explicit empty string clears the section')
  const read = await route({})
  check(read.content === '', 'and the store agrees')
  check(read.enabled === true, 'while the switch stays where the user left it')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
process.exit(0)