/**
 * dsh-memory — identity-file HTTP routes (R3-ui 2026-08-31).
 *
 * Exposes the soul.md / user.md files to the settings UI over one `webServer`
 * route (the same seam meow-memory uses). The files stay the source of truth
 * (decision ② A): the UI edits them through this route, and a human can still
 * hand-edit the same files.
 *
 *   GET  /memory/identity        → { ok: true, soul, user }
 *   POST /memory/identity        → { ok: true }  body: { file: 'soul'|'user', content }
 *
 * SECURITY (P1-3/G2/G3, review 2026-09-01): both GET and POST require loopback
 * source. The check uses socket.remoteAddress (transport-layer fact, cannot be
 * spoofed via Host/Origin headers). This blocks LAN clients and DNS-rebinding
 * pages even when the webServer is bound beyond loopback.
 *
 * `webServer` is an optional host service that may come up after this plugin
 * (fiber startup race), so registration retries once a second (≤20 attempts)
 * and degrades silently when the seam is absent. The route is registered inside
 * a ctx.effect so a hot reload un-registers it (no duplicate-route residue).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore } from './store.js'
import { readIdentityFiles, writeIdentityFile } from './identity.js'

/** Loopback IP addresses (transport-layer fact, cannot be spoofed via headers). */
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Get the remote IP from the request socket (transport-layer, cannot be spoofed). */
function getRemoteIp(req: unknown): string {
  const socket = (req as { socket?: { remoteAddress?: string } }).socket
  return socket?.remoteAddress ?? ''
}

/** P1-3/G2: request is trusted only from loopback. Uses socket.remoteAddress
 *  (transport-layer fact, cannot be spoofed via Host/Origin headers).
 *  This blocks LAN clients and DNS-rebinding pages even on non-loopback binds. */
function isTrustedRequest(req: unknown): boolean {
  const ip = getRemoteIp(req)
  return LOOPBACK_IPS.has(ip)
}

/** Unified JSON response (route use). */
function writeJson(res: unknown, status: number, body: unknown): void {
  try {
    const r = res as { writeHead?: (code: number, headers: Record<string, string>) => void; end?: (chunk?: string) => void }
    r.writeHead?.(status, { 'content-type': 'application/json' })
    r.end?.(JSON.stringify(body))
  } catch {
    /* response failure is not fatal */
  }
}

/** Read a POST JSON body (64 KB cap; empty body = {}). Over-limit requests are
 *  destroyed so a slow-loris style sender cannot hold the connection open.
 *  A7: add idle timeout (5s) to prevent slow-loris style connection holding. */
function readJsonBody(req: unknown, maxBytes = 65_536): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const r = req as { on?: (ev: string, cb: (chunk?: unknown) => void) => void; destroy?: () => void; setTimeout?: (ms: number) => void }
    const chunks: Buffer[] = []
    let size = 0
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        reject(new Error('request body idle timeout'))
        r.destroy?.()
      }, 5_000)
    }
    resetIdleTimer()
    r.on?.('data', (chunk: unknown) => {
      resetIdleTimer()
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
      size += buf.length
      if (size > maxBytes) {
        reject(new Error('request body too large'))
        r.destroy?.()
        return
      }
      chunks.push(buf)
    })
    r.on?.('end', () => {
      if (idleTimer) clearTimeout(idleTimer)
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e instanceof Error ? e : new Error(String(e))) }
    })
    r.on?.('error', (e: unknown) => {
      if (idleTimer) clearTimeout(idleTimer)
      reject(e instanceof Error ? e : new Error(String(e)))
    })
  })
}

/**
 * Register the `/memory/identity` route. Returns a disposer that only cancels the
 * registration retry timer; the route itself lives in a ctx.effect so the fiber
 * un-registers it on dispose.
 */
export function registerIdentityRoutes(ctx: Context, store: MemoryStore): () => void {
  let routeTimer: ReturnType<typeof setTimeout> | undefined
  let done = false

  const tryRegister = (attempt: number): void => {
    if (done) return
    const ws = (ctx as { get?: (name: string) => unknown }).get?.('webServer') as
      | { register?: (route: { kind: 'exact'; path: string; handler: (req: unknown, res: unknown) => void }) => () => void }
      | undefined
    if (ws !== undefined && typeof ws.register === 'function') {
      // 永远保留 ws 作为接收者：webServer.register 内部依赖 this 访问路由表，
      // 直接解绑裸调（const r = ws.register; r(...)）会让 this 变 undefined，
      // 触发 "Cannot read properties of undefined (reading 'exact')"。meow 用
      // 的是 ctx.effect(() => ws.register(route)) 不解绑；这里为兼容 TS strict
      // 的 optional-call 检查改 bind(ws)，行为等价。
      const register = ws.register.bind(ws)
      try {
        ctx.effect(() => register({
          kind: 'exact',
          path: '/memory/identity',
          handler: (req, res) => {
            void (async () => {
              try {
                // G2/G3: both GET and POST require loopback source (transport-layer check)
                if (!isTrustedRequest(req)) {
                  writeJson(res, 403, { ok: false, error: 'access only allowed from loopback (127.0.0.1/::1)' })
                  return
                }
                const method = (req as { method?: string }).method
                if (method === 'POST') {
                  const body = await readJsonBody(req) as { file?: unknown; content?: unknown }
                  const file = body.file === 'soul' || body.file === 'user' ? body.file : undefined
                  const content = typeof body.content === 'string' ? body.content : ''
                  if (file === undefined) { writeJson(res, 400, { ok: false, error: "file must be 'soul' or 'user'" }); return }
                  writeIdentityFile(store.dir, file, content)
                  writeJson(res, 200, { ok: true })
                  return
                }
                const files = readIdentityFiles(store.dir)
                writeJson(res, 200, { ok: true, soul: files.soul, user: files.user })
              } catch (e) {
                writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
              }
            })()
          },
        }))
      } catch (e) {
        if (!done) console.warn('[dsh-memory] identity route registration failed:', e instanceof Error ? e.message : e)
      }
      return
    }
    if (attempt < 20) routeTimer = setTimeout(() => tryRegister(attempt + 1), 1000)
    else console.warn('[dsh-memory] webServer service unavailable; identity routes not registered')
  }
  tryRegister(0)

  return () => {
    done = true
    if (routeTimer !== undefined) clearTimeout(routeTimer)
  }
}
