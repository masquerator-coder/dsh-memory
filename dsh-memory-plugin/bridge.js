import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, join, resolve } from 'node:path'
import process from 'node:process'

/**
 * Transport to the Python `memory_system` bridge.
 *
 * The host owns no memory logic: every read and write goes through the
 * `memory_system` package, which runs in a child process behind a
 * newline-delimited JSON protocol. The process boundary keeps the storage
 * rules independently testable and stops the model-owning half of the harness
 * from growing a second, divergent memory implementation.
 *
 * @module dsh-memory/bridge
 */

/** One bridge failure with a stable, machine-routable code. */
export class BridgeError extends Error {
  /**
   * @param {string} message - human-readable diagnosis.
   * @param {string} code - stable failure class for callers and the UI.
   * @param {object} [options] - optional cause.
   */
  constructor(message, code, options = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/**
 * Interpreters to try, most specific first.
 * @param {string} configured - the `pythonPath` config value.
 * @returns {string[]} distinct candidates in preference order.
 */
function candidateInterpreters(configured) {
  const list = []
  if (configured) list.push(configured)
  for (const name of ['DSH_MEMORY_PYTHON', 'DSH_PYTHON']) {
    const value = process.env[name]
    if (value) list.push(value)
  }
  list.push('python')
  const seen = new Set()
  return list.filter((item) => {
    const key = process.platform === 'win32' ? item.toLowerCase() : item
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Environment that makes `memory_system` importable in the child.
 * @param {string} root - repository root owning the package.
 * @returns {Record<string, string | undefined>} child environment.
 */
function childEnv(root) {
  const env = { ...process.env }
  // The protocol is UTF-8 on every platform. Without these a legacy console
  // code page decodes CJK into replacement characters (observed on GBK).
  env.PYTHONUTF8 = '1'
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUNBUFFERED = '1'
  if (root) {
    const existing = env.PYTHONPATH
    env.PYTHONPATH = existing ? `${join(root, '')}${delimiter}${existing}` : root
  }
  return env
}

/**
 * A warm, strictly serialized NDJSON connection to one bridge process.
 *
 * One request is in flight at a time: the protocol has no multiplexing, and
 * answers arrive in order. A timeout kills the child, because a late answer
 * would otherwise be attributed to the next request.
 */
export class BridgeClient {
  /**
   * @param {object} options - resolved plugin configuration.
   * @param {string} options.pythonPath - interpreter path or name; empty to probe.
   * @param {string} options.root - repository root containing `memory_system`.
   * @param {number} options.timeoutMs - per-request timeout in ms.
   * @param {{ info: Function, warn: Function }} options.logger - plugin logger.
   */
  constructor({ pythonPath, root, timeoutMs, logger }) {
    this.pythonPath = pythonPath
    this.root = root
    this.timeoutMs = timeoutMs
    this.logger = logger
    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.child = undefined
    /** @type {Array<{ resolve: Function, reject: Function, timer: any }>} */
    this.pending = []
    this.buffer = ''
    this.seq = 0
    this.disposed = false
  }

  /** Reject waiters and stop the child. */
  stop(error) {
    const child = this.child
    this.child = undefined
    this.buffer = ''
    if (child) {
      try {
        child.kill()
      } catch {
        // Already exited: nothing to clean up.
      }
    }
    const waiting = this.pending
    this.pending = []
    for (const entry of waiting) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  /** Stop the child; outstanding requests fail with `DISPOSED`. */
  dispose() {
    this.disposed = true
    this.stop(new BridgeError('记忆插件已卸载', 'DISPOSED'))
  }

  /** Wait for queued work to finish, then stop the child. */
  async settle() {
    const deadline = Date.now() + Math.min(this.timeoutMs, 10_000)
    while (this.pending.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    this.dispose()
  }

  /**
   * Spawn the child on first use and wire its protocol streams.
   * @returns {import('node:child_process').ChildProcess} the live child.
   */
  ensureChild() {
    if (this.disposed) throw new BridgeError('记忆插件已卸载', 'DISPOSED')
    if (this.child) return this.child
    const env = childEnv(this.root)
    const attempted = []
    for (const candidate of candidateInterpreters(this.pythonPath)) {
      attempted.push(candidate)
      let child
      try {
        child = spawnBridge(candidate, this.root, env)
      } catch (error) {
        this.logger.warn(`[dsh-memory] cannot spawn "${candidate}": ${error?.message ?? error}`)
        continue
      }
      this.child = child
      this.attach(child)
      this.logger.info(`[dsh-memory] bridge started via "${candidate}"${this.root ? ` at ${this.root}` : ''}`)
      return child
    }
    throw new BridgeError(
      `找不到可用的 Python 解释器：${attempted.join(', ')}。请在插件配置中设置 pythonPath，或安装含 memory_system 的 Python。`,
      'NO_PYTHON',
    )
  }

  /**
   * Wire lifecycle and protocol handlers for a freshly spawned child.
   * @param {import('node:child_process').ChildProcess} child - the new child.
   */
  attach(child) {
    const fail = (error) => {
      if (this.child === child) this.stop(error)
    }
    child.once('error', (error) => {
      fail(new BridgeError(`Python 记忆桥启动失败：${error.message}`, 'SPAWN_FAILED', { cause: error }))
    })
    child.once('exit', (code, signal) => {
      fail(new BridgeError(`Python 记忆桥已退出（code=${code}, signal=${signal}）`, 'BRIDGE_EXIT'))
    })
    if (child.stdout) child.stdout.setEncoding('utf8')
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (text) => {
        const line = String(text).trim()
        if (line.length > 0) this.logger.warn(`[dsh-memory] python: ${line.slice(0, 2000)}`)
      })
    }
    if (child.stdout) child.stdout.on('data', (text) => this.onStdout(text))
  }

  /**
   * Consume complete protocol lines and answer their waiters in order.
   * @param {string} text - decoded stdout chunk.
   */
  onStdout(text) {
    this.buffer += text
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.logger.warn(`[dsh-memory] non-JSON line from bridge: ${line.slice(0, 300)}`)
        continue
      }
      const entry = this.pending.shift()
      if (!entry) {
        this.logger.warn('[dsh-memory] bridge answered with no request pending')
        continue
      }
      clearTimeout(entry.timer)
      if (message.ok) {
        entry.resolve(message.result)
      } else {
        const failure = message.error ?? {}
        entry.reject(
          new BridgeError(
            typeof failure.message === 'string' ? failure.message : '记忆桥返回未知错误',
            typeof failure.code === 'string' ? failure.code : 'BRIDGE_FAILED',
          ),
        )
      }
    }
  }

  /**
   * Run one bridge command.
   * @param {string} command - bridge command name.
   * @param {object} [payload] - command arguments.
   * @param {AbortSignal} [signal] - cancels the wait only.
   * @returns {Promise<any>} the command result.
   */
  async call(command, payload = {}, signal) {
    const child = this.ensureChild()
    if (signal?.aborted) throw new BridgeError('请求已取消', 'ABORTED')
    this.seq += 1
    const body = `${JSON.stringify({ id: `h${this.seq}`, command, payload })}\n`
    return await new Promise((resolve, reject) => {
      let entry
      const remove = () => {
        const at = this.pending.indexOf(entry)
        if (at >= 0) this.pending.splice(at, 1)
        clearTimeout(entry.timer)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        remove()
        reject(new BridgeError('请求已取消', 'ABORTED'))
      }
      entry = {
        timer: setTimeout(() => {
          remove()
          reject(new BridgeError(`记忆桥无响应（${command}）`, 'TIMEOUT'))
          // A late answer must never be matched to a later request.
          this.stop(new BridgeError('记忆桥超时，已重启', 'BRIDGE_RESTARTED'))
        }, this.timeoutMs),
        resolve: (value) => {
          remove()
          resolve(value)
        },
        reject: (error) => {
          remove()
          reject(error)
        },
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this.pending.push(entry)
      child.stdin.write(body, 'utf8', (error) => {
        if (!error) return
        entry.reject(new BridgeError(`写入记忆桥失败：${error.message}`, 'BRIDGE_WRITE_FAILED', { cause: error }))
      })
    })
  }
}

/**
 * Spawn one bridge process.
 * @param {string} interpreter - interpreter path or name.
 * @param {string} root - working directory for the child.
 * @param {Record<string, string | undefined>} env - child environment.
 * @returns {import('node:child_process').ChildProcess} the spawned child.
 */
function spawnBridge(interpreter, root, env) {
  return spawn(interpreter, ['-W', 'ignore', '-m', 'memory_system', '--serve'], {
    cwd: root || undefined,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** Default memory home, mirroring `memory_system.bridge.default_home`. */
export function defaultMemoryHome() {
  if (process.env.DSH_MEMORY_HOME) return process.env.DSH_MEMORY_HOME
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'memory')
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'memory')
}

/**
 * Repository root that ships `memory_system`, derived from this file's own
 * location so the plugin works wherever it was installed (a git checkout, a
 * linked package, or a copied directory) instead of naming one machine.
 * @returns {string} the directory one level above the plugin directory.
 */
export function defaultMemorySystemRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** Internals exposed for the plugin's self-check. */
export const bridgeInternals = { candidateInterpreters, childEnv, spawnBridge }