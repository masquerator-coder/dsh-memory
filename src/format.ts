/**
 * dsh-memory — entry formatting for every model-facing listing surface.
 *
 * Extracted from tools.ts (zero dsh dependency) so smoke.mjs can unit-test it
 * directly — untestable surfaces rot silently.
 */
import type { Episode, MemoryEntry } from './types.js'

/** Render semantic memories for every model-facing listing surface.
 *  (P0-6) content is untrusted model-written text; collapse newlines/control
 *  chars so a single entry can never forge an extra list line. */
export function formatEntries(entries: readonly MemoryEntry[]): string {
  return entries.map(e =>
    `[${e.layer}/${e.tier}${e.low_quality ? '/低质' : ''} i=${e.importance}] (${e.id}) ${e.topic}: ${oneLine(e.content)}`,
  ).join('\n')
}

/** Render episodic (session) memories. (P0-6) same one-line guard on summary. */
export function formatEpisodes(episodes: readonly Episode[]): string {
  return episodes.map(ep =>
    `[${ep.topic}] ${ep.session_id} · ${oneLine(ep.summary)}${ep.tools_used ? ` (工具:${ep.tools_used})` : ''}`,
  ).join('\n')
}

/** Collapse newlines/control characters and trim — content may not inject lines. */
function oneLine(s: string): string {
  return String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
}

// ---- UI tool-card presentation (pure, smoke-testable) -----------------
// The dsh tool-call card is the plugin's UI surface for memory actions.
// presentCall/presentResult light up the card but live in the dsh boundary
// (tools.ts), which smoke cannot drive — so the verdict logic is extracted
// here as pure functions and locked down by smoke instead.

/** Completed-card verdict for a write. */
export function writeVerdictLabel(action: string): string {
  return action === 'add' ? '已记入' : action === 'replace' ? '已纠正' : action === 'remove' ? '已删除' : '记忆操作'
}

/** Empty recall outcome gives the card a "no match" header. */
export function recallEmptyLabel(): string {
  return '无匹配记忆'
}

/** Whether an execute text signals a non-write outcome (rejected / overflow / unknown action). */
export function writeFailed(text: string): boolean {
  return text.includes('未完成') || text.includes('预算已满') || text.includes('未知 action')
}
