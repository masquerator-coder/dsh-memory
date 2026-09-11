/**
 * Session adapter — the memory-write trigger. Listens on the `session/event`
 * firehose for durable user messages and feeds them into the fast channel
 * (deterministic rules) and slow channel (optional LLM extraction). The main
 * LLM never extracts here (design §6.3); capture is delegated to the background
 * queue so the session path stays non-blocking.
 *
 * @module dsh-memory/adapters/session
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { MemoryService } from '../service.ts'

/** Pull the plain text out of a user message's content blocks. */
export function userMessageText(event: SessionEvent<'user/message'>): string {
  const blocks = event.data.content
  if (blocks.length === 0) return ''
  const [first] = blocks
  if (first?.type === 'text') return first.text
  return ''
}

/** Whether a user message is a genuine human prompt (vs. plugin-sourced context). */
export function isDirectUserMessage(event: SessionEvent<'user/message'>): boolean {
  return event.data.source.kind === 'user'
}

/**
 * Register the session/event listener. When `captureEnabled`, each direct user
 * message with a fact-worthy signal is handed to `memory.extractAndRemember`,
 * which decides fast/slow capture and enqueues it.
 */
export function registerSessionCapture(ctx: Context, captureEnabled: boolean): () => void {
  return ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'user/message') return
    if (!isDirectUserMessage(event)) return
    const memory = ctx.get('memory') as MemoryService | undefined
    if (memory === undefined) return
    if (!captureEnabled) return
    const text = userMessageText(event)
    if (text.trim().length === 0) return
    // Fast channel always runs; the triggers are cheap.
    memory.extractAndRemember({
      text,
      scope: session.id,
      sourceUri: `session:${session.id}#seq-${event.seq}`,
    })
  })
}
