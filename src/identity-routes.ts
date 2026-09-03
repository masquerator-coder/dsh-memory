/**
 * dsh-memory — identity-file + memory-control HTTP routes (R3-ui 2026-09-02).
 *
 * Exposes the soul.md / user.md files AND the memory condensation workflow to
 * the settings UI over one `webServer` seam (the same route family meow-memory
 * uses). The files stay the source of truth (decision ② A): the UI edits them
 * through this route, and a human can still hand-edit the same files.
 *
 *   GET  /memory/identity        → { ok: true, soul, user }
 *   POST /memory/identity        → { ok: true }          body: { file: 'soul'|'user', content }
 *   POST /memory/identity/open   → { ok: true, path }    body: { file: 'soul'|'user' }  — open in a local editor
 *   POST /memory/trigger         → { ok: true, result }  — run an immediate condensation/identity/forget pass
 *   GET  /memory/view            → { ok: true, ...digest } — memory digest for the viewer window
 *   GET  /memory/backup/export   → attachment .db        — download a full VACUUM INTO snapshot
 *   POST /memory/backup/import   → { ok: true, memories, episodes }  body: raw .db bytes — REPLACES all data
 *
 * SECURITY (P1-3/G2/G3, review 2026-09-01): every route requires a loopback
 * source. The check uses socket.remoteAddress (transport-layer fact, cannot be
 * spoofed via Host/Origin headers). This blocks LAN clients and DNS-rebinding
 * pages even when the webServer is bound beyond loopback.
 *
 * `webServer` is an optional host service that may come up after this plugin
 * (fiber startup race), so registration retries once a second (≤20 attempts)
 * and degrades silently when the seam is absent. The routes are registered
 * inside a ctx.effect so a hot reload un-registers them (no duplicate residue).
 */
import type { Context } from '@deepseek-ai/cordis'
import { MemoryStore } from './store.js'
import type { MemoryEntry } from './types.js'
import { readIdentityFiles, writeIdentityFile } from './identity.js'
import { exec } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

/** Loopback IP addresses (transport-layer fact, cannot be spoofed via headers). */
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** The two identity files; `file` is narrowed here so a caller cannot escape the
 *  identity directory via path traversal. */
const IDENTITY_FILE = { soul: 'soul.md', user: 'user.md' } as const

/** Result of an immediate "整理记忆" pass, returned by the trigger route. */
export interface RunNowResult {
  refined: boolean
  forgetDemoted: number
  forgetArchivedMem: number
  forgetDeletedMem: number
  forgetArchivedEpi: number
  forgetDeletedEpi: number
}

/** Handlers wired in by the plugin entry (where the actual pass closures live). */
export interface MemoryControlHandlers {
  /** Run condensation (L1/L2) + identity maintenance + forgetting immediately. */
  runNow: () => Promise<RunNowResult>
  /** R10: enumerate the host LLM registry for the refine-model picker. */
  loadModels: () => Promise<RefineModelsPayload>
}

/** R10: one selectable refine-model candidate (host LLM registry entry). */
export interface RefineModelCandidate {
  provider: string
  model: string
  name?: string
}

/** R10: payload of /memory/models — candidates from the live LLM registry
 *  (the same source the dsh model picker uses) plus the host default route. */
export interface RefineModelsPayload {
  /** Host default model route (agentDefaultModel), for the auto hint. */
  default: { provider?: string; model?: string }
  candidates: RefineModelCandidate[]
  /** Providers whose model list could not be read (kept for the UI hint). */
  failures: { id: string; name: string; message: string }[]
}

/** One memory row in the viewer digest. */
export interface ViewMemory {
  id: string
  layer: string
  tier: number
  kind: string
  topic: string
  importance: number
  content: string
  created: number
  updated: number
  archived: boolean
  lowQuality: boolean
}

/** Digest payload for the "查看记忆" viewer window. */
export interface ViewPayload {
  memories: ViewMemory[]
  memoryCount: number
  episodeCount: number
  topics: { topic: string; count: number }[]
  updatedMs: number
}

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

/** Open a file in the platform's default editor (file association). Returns a
 *  live result promise; a missing editor/association resolves ok:false. */
function openInLocalEditor(absPath: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let cmd: string
    let shell: Parameters<typeof exec>[1] | undefined
    if (process.platform === 'win32') {
      // `start "" "<path>"` launches via the file's default association.
      cmd = `start "" "${absPath.replace(/"/g, '^"')}"`
      shell = { shell: 'cmd.exe' } as unknown as Parameters<typeof exec>[1]
    } else if (process.platform === 'darwin') {
      cmd = `open "${absPath.replace(/(["\\$`])/g, '\\$1')}"`
      shell = undefined
    } else {
      cmd = `xdg-open "${absPath.replace(/(["\\$`])/g, '\\$1')}"`
      shell = undefined
    }
    exec(cmd, shell ?? {}, (err) => {
      if (err) resolve({ ok: false, error: err.message })
      else resolve({ ok: true })
    })
  })
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

/** Read a raw (binary) POST body into a Buffer, for backup import. Capped at
 *  `maxBytes` (default 100 MiB — a memory .db snapshot stays far below this,
 *  but FTS + audit trails can push a long-lived store into the multi-MB range)
 *  and drained with the same slow-loris idle timeout as {@link readJsonBody}. */
function readRawBody(req: unknown, maxBytes = 100 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const r = req as {
      on?: (ev: 'data' | 'end' | 'error', cb: (...a: unknown[]) => void) => void
      destroy?: () => void
      setTimeout?: (ms: number) => void
    }
    const chunks: Buffer[] = []
    let size = 0
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        reject(new Error('request body idle timeout'))
        r.destroy?.()
      }, 10_000)
    }
    resetIdleTimer()
    r.on?.('data', (chunk: unknown) => {
      resetIdleTimer()
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
      size += buf.length
      if (size > maxBytes) {
        reject(new Error('backup file too large'))
        r.destroy?.()
        return
      }
      chunks.push(buf)
    })
    r.on?.('end', () => {
      if (idleTimer) clearTimeout(idleTimer)
      resolve(Buffer.concat(chunks))
    })
    r.on?.('error', (e: unknown) => {
      if (idleTimer) clearTimeout(idleTimer)
      reject(e instanceof Error ? e : new Error(String(e)))
    })
  })
}

/** Build the viewer digest from the store (active memories + episode count +
 *  topic index). Pure read — never mutates the store. */
function buildViewPayload(store: MemoryStore): ViewPayload {
  const rows: MemoryEntry[] = store.list({ includeArchived: false, includeLowQuality: false })
  const memories: ViewMemory[] = rows.map((e) => ({
    id: e.id,
    layer: e.layer,
    tier: e.tier,
    kind: e.kind,
    topic: e.topic,
    importance: e.importance,
    content: e.content,
    created: e.created,
    updated: e.updated,
    archived: e.archived,
    lowQuality: e.low_quality,
  })).slice(0, 400)
  return {
    memories,
    memoryCount: store.count(),
    episodeCount: store.episodeCount(),
    topics: store.topicsIndex(),
    updatedMs: Date.now(),
  }
}

type RouteHandler = (req: unknown, res: unknown) => void

/**
 * Register the dsh-memory HTTP routes. Returns a disposer that only cancels the
 * registration retry timer; each route itself lives in a ctx.effect so the
 * fiber un-registers it on dispose.
 */
export function registerControlRoutes(
  ctx: Context,
  store: MemoryStore,
  handlers: MemoryControlHandlers,
): () => void {
  let routeTimer: ReturnType<typeof setTimeout> | undefined
  let done = false

  /** Identity-file editor. */
  const identityEditor: RouteHandler = (req: unknown, res: unknown): void => {
    void (async () => {
      try {
        if (!isTrustedRequest(req)) { writeJson(res, 403, { ok: false, error: 'access only allowed from loopback (127.0.0.1/::1)' }); return }
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
  }

  /** Open one identity file in a local editor. */
  const identityOpen: RouteHandler = (req: unknown, res: unknown): void => {
    void (async () => {
      try {
        if (!isTrustedRequest(req)) { writeJson(res, 403, { ok: false, error: 'access only allowed from loopback (127.0.0.1/::1)' }); return }
        const body = await readJsonBody(req) as { file?: unknown }
        const file = body.file === 'soul' || body.file === 'user' ? body.file : undefined
        if (file === undefined) { writeJson(res, 400, { ok: false, error: "file must be 'soul' or 'user'" }); return }
        const absPath = join(store.dir, IDENTITY_FILE[file])
        const opened = await openInLocalEditor(absPath)
        if (opened.ok) writeJson(res, 200, { ok: true, path: absPath, file: basename(absPath) })
        else writeJson(res, 500, { ok: false, error: opened.error ?? 'no default editor' })
      } catch (e) {
        writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  }

  /** Run an immediate condensation / identity / forget pass. */
  const trigger: RouteHandler = (req: unknown, res: unknown): void => {
    void (async () => {
      try {
        if (!isTrustedRequest(req)) { writeJson(res, 403, { ok: false, error: 'access only allowed from loopback (127.0.0.1/::1)' }); return }
        if (req && (req as { method?: string }).method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        const result = await handlers.runNow()
        writeJson(res, 200, { ok: true, result })
      } catch (e) {
        writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  }

  /** Return a memory digest for the viewer window. */
  const view: RouteHandler = (req: unknown, res: unknown): void => {
    void (async () => {
      try {
        if (!isTrustedRequest(req)) { writeJson(res, 403, { ok: false, error: 'access only allowed from loopback (127.0.0.1/::1)' }); return }
        writeJson(res, 200, { ok: true, ...buildViewPayload(store) })
      } catch (e) {
        writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  }

  /** Download a full store snapshot (VACUUM INTO .db) as an attachment. */
  const backupExport: RouteHandler = (req: unknown, res: unknown): void => {
    void (async () => {
      try {
        if (!isTrustedRequest(req)) { writeJson(res, 403, { ok: false, error: 'access only allowed from loopback (127.0.0.1/::1)' }); return }
        if ((req as { method?: string }).method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        // VACUUM INTO writes a consistent, self-contained snapshot to a temp
        // file; read it fully (a memory store is KB–low-MB), then clean up.
        const tmpFile = join(tmpdir(), `dsh-memory-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
        let buf: Buffer
        try {
          store.exportSnapshot(tmpFile)
          buf = readFileSync(tmpFile)
        } finally {
          try { unlinkSync(tmpFile) } catch { /* best-effort cleanup */ }
        }
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        const r = res as { writeHead?: (code: number, headers: Record<string, string>) => void; end?: (chunk?: Buffer | string) => void }
        r.writeHead?.(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="dsh-memory-backup-${stamp}.db"`,
        })
        r.end?.(buf)
      } catch (e) {
        writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  }

  /** Restore the store from an uploaded backup .db — REPLACES all current data.
   *  Body is the raw .db bytes (not JSON). */
  const backupImport: RouteHandler = (req: unknown, res: unknown): void => {
    void (async () => {
      try {
        if (!isTrustedRequest(req)) { writeJson(res, 403, { ok: false, error: 'access only allowed from loopback (127.0.0.1/::1)' }); return }
        if ((req as { method?: string }).method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        const body = await readRawBody(req)
        if (body.length === 0) { writeJson(res, 400, { ok: false, error: '未收到备份文件内容' }); return }
        const tmpFile = join(tmpdir(), `dsh-memory-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
        try {
          writeFileSync(tmpFile, body)
          // Validate first (400 on a bogus file) so we never clobber on garbage;
          // replaceWithBackup re-validates as its own gate before the swap.
          const check = MemoryStore.validateBackup(tmpFile)
          if (!check.ok) { writeJson(res, 400, { ok: false, error: check.error }); return }
          const result = store.replaceWithBackup(tmpFile)
          writeJson(res, 200, { ok: true, memories: result.memories, episodes: result.episodes })
        } finally {
          try { unlinkSync(tmpFile) } catch { /* best-effort cleanup */ }
        }
      } catch (e) {
        writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  }

  /** Return the refine-model catalog for the settings picker (R10). */
  const models: RouteHandler = (req: unknown, res: unknown): void => {
    void (async () => {
      try {
        if (!isTrustedRequest(req)) { writeJson(res, 403, { ok: false, error: 'access only allowed from loopback (127.0.0.1/::1)' }); return }
        if ((req as { method?: string }).method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        const payload = await handlers.loadModels()
        writeJson(res, 200, { ok: true, ...payload })
      } catch (e) {
        writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  }

  const routes: { path: string; handler: RouteHandler }[] = [
    { path: '/memory/identity', handler: identityEditor },
    { path: '/memory/identity/open', handler: identityOpen },
    { path: '/memory/trigger', handler: trigger },
    { path: '/memory/view', handler: view },
    { path: '/memory/models', handler: models },
    { path: '/memory/backup/export', handler: backupExport },
    { path: '/memory/backup/import', handler: backupImport },
  ]

  const tryRegister = (attempt: number): void => {
    if (done) return
    const ws = (ctx as { get?: (name: string) => unknown }).get?.('webServer') as
      | { register?: (route: { kind: 'exact'; path: string; handler: RouteHandler }) => () => void }
      | undefined
    if (ws !== undefined && typeof ws.register === 'function') {
      // 永远保留 ws 作为接收者：webServer.register 内部依赖 this 访问路由表，
      // 直接解绑裸调（const r = ws.register; r(...)）会让 this 变 undefined，
      // 触发 "Cannot read properties of undefined (reading 'exact')"。meow 用
      // 的是 ctx.effect(() => ws.register(route)) 不解绑；这里为兼容 TS strict
      // 的 optional-call 检查改 bind(ws)，行为等价。
      const register = ws.register.bind(ws)
      for (const route of routes) {
        try {
          ctx.effect(() => register({ kind: 'exact', path: route.path, handler: route.handler }))
        } catch (e) {
          if (!done) console.warn(`[dsh-memory] route registration failed for ${route.path}:`, e instanceof Error ? e.message : e)
        }
      }
      return
    }
    if (attempt < 20) routeTimer = setTimeout(() => tryRegister(attempt + 1), 1000)
    else console.warn('[dsh-memory] webServer service unavailable; control routes not registered')
  }
  tryRegister(0)

  return () => {
    done = true
    if (routeTimer !== undefined) clearTimeout(routeTimer)
  }
}
