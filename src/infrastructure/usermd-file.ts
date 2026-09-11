/**
 * user.md file adapter — the thin I/O + watch bridge between the pure
 * render/parse/sync engines and a real `user.md` on disk (design §8.4). It
 * renders the card to the file and watches for external edits (e.g. in
 * Obsidian), feeding changed content back to the sync engine. All "logic"
 * (grouping, parsing, diffing) lives in the pure modules; this class only
 * serializes writes, debounces watcher events, and prevents reacting to its own
 * writes.
 *
 * @module dsh-memory/infrastructure/usermd-file
 */
import { readFile, writeFile, mkdir, watch } from 'node:fs'
import { dirname } from 'node:path'

export interface UserMdFileOptions {
  /** Debounce window for coalescing rapid editor writes (ms). */
  readonly debounceMs?: number
  /** Called with changed external content when the file is edited externally. */
  onExternalChange?: (content: string) => void
}

const DEFAULT_DEBOUNCE_MS = 500

export class UserMdFile {
  private lastRendered = ''
  private debounced: NodeJS.Timeout | undefined
  private disposed = false
  private readonly debounceMs: number

  constructor(
    private readonly filePath: string,
    private readonly options: UserMdFileOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  /** Read the current on-disk content (empty string when absent). */
  read(): Promise<string> {
    return new Promise(resolve => {
      readFile(this.filePath, 'utf8', (err, data) => {
        resolve(err ? '' : data)
      })
    })
  }

  /** Render + write atomically, and record the content we wrote. */
  async write(content: string): Promise<void> {
    this.lastRendered = content
    await new Promise<void>((resolve, reject) => {
      mkdir(dirname(this.filePath), { recursive: true }, err => {
        if (err) return reject(err)
        writeFile(this.filePath, content, 'utf8', err2 => (err2 ? reject(err2) : resolve()))
      })
    })
  }

  /**
   * Start watching the file for external edits. Changes are debounced and, when
   * the new content differs from the last content this adapter wrote, delivered
   * to `onChange`. Returns a disposer. Safe to call once. (Convenience overload:
   * the handler may also be supplied at construction via `options.onExternalChange`.)
   */
  watch(onChange?: (content: string) => void): () => void {
    if (this.disposed) return () => {}
    this.disposed = true
    const handle = onChange ?? this.options.onExternalChange
    const notify = (): void => {
      if (this.debounced !== undefined) clearTimeout(this.debounced)
      this.debounced = setTimeout(() => {
        void this.read().then((content) => {
          // Ignore the content we just wrote ourselves.
          if (content === this.lastRendered) return
          if (content.length === 0) return
          handle?.(content)
        })
      }, this.debounceMs)
    }
    const watcher = watch(this.filePath, { persistent: false }, notify)
    return () => {
      watcher.close()
      if (this.debounced !== undefined) clearTimeout(this.debounced)
      this.disposed = true
    }
  }

  /** Whether the on-disk file currently differs from the last content we wrote. */
  hasExternalChange(): Promise<boolean> {
    return this.read().then(content => content !== this.lastRendered)
  }
}
