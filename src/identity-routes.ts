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
 * `webServer` is an optional host service that may come up after this plugin
 * (fiber startup race), so registration retries once a second (≤20 attempts)
 * and degrades silently when the seam is absent. The route is registered inside
 * a ctx.effect so a hot reload un-registers it (no duplicate-route residue).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore } from './store.js'
import { readIdentityFiles, writeIdentityFile } from './identity.js'

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

/** Read a POST JSON body (64 KB cap; empty body = {}). */
function readJsonBody(req: unknown, maxBytes = 65_536): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const r = req as { on?: (ev: string, cb: (chunk?: unknown) => void) => void }
    const chunks: Buffer[] = []
    let size = 0
    r.on?.('data', (chunk: unknown) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
      size += buf.length
      if (size > maxBytes) { reject(new Error('request body too large')); return }
      chunks.push(buf)
    })
    r.on?.('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e instanceof Error ? e : new Error(String(e))) }
    })
    r.on?.('error', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))))
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
      const register = ws.register
      try {
        ctx.effect(() => register({
          kind: 'exact',
          path: '/memory/identity',
          handler: (req, res) => {
            void (async () => {
              try {
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
