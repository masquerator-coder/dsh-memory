import { describe, expect, it } from 'vitest'
import { OutboxJournal } from '../src/infrastructure/outbox-journal'
import { backoffDelayMs, DEFAULT_BACKOFF } from '../src/domain/outbox'

describe('OutboxJournal', () => {
  it('appends pending entries keyed by op:factId and lists them when due', async () => {
    const journal = new OutboxJournal(() => 1000)
    await journal.append('index', 'fact_1', 'scope:a')
    await journal.append('index', 'fact_2', 'scope:a')

    const due = await journal.pendingDue(1000, 100)
    expect(due.map(e => e.factId).sort()).toEqual(['fact_1', 'fact_2'])
    for (const e of due) {
      expect(e.state).toBe('pending')
      expect(e.attempts).toBe(0)
      expect(e.nextAttemptAt).toBe(1000)
    }
  })

  it('coalesces duplicate appends of the same pending change (idempotency)', async () => {
    const journal = new OutboxJournal(() => 1000)
    await journal.append('index', 'fact_1', 'scope:a')
    await journal.append('index', 'fact_1', 'scope:a')
    await journal.append('unindex', 'fact_1', 'scope:a')
    const due = await journal.pendingDue(1000, 100)
    // index + unindex are distinct ops → 2 entries; the duplicate index coalesced.
    expect(due).toHaveLength(2)
    const ops = due.map(e => e.op).sort()
    expect(ops).toEqual(['index', 'unindex'])
  })

  it('does not return entries whose backoff horizon has not passed', async () => {
    const journal = new OutboxJournal(() => 1000)
    await journal.append('index', 'fact_1', 'scope:a')
    const pending = await journal.pendingDue(1000, 100)
    expect(pending).toHaveLength(1)
    await journal.markFailed(pending[0].id, 'boom', 2000)
    expect(await journal.pendingDue(1500, 100)).toEqual([])
    const retry = await journal.pendingDue(2000, 100)
    expect(retry).toHaveLength(1)
    expect(retry[0].attempts).toBe(1)
    expect(retry[0].lastError).toBe('boom')
  })

  it('tracks done / failed / dead / pending counts', async () => {
    const journal = new OutboxJournal(() => 1000)
    await journal.append('index', 'a', 's')
    await journal.append('index', 'b', 's')
    await journal.append('index', 'c', 's')
    const due = await journal.pendingDue(1000, 100)
    await journal.markDone(due[0].id)
    await journal.markFailed(due[1].id, 'x', 5000)
    await journal.markDead(due[2].id)
    const stats = await journal.stats()
    expect(stats.done).toBe(1)
    expect(stats.failed).toBe(1)
    expect(stats.dead).toBe(1)
    expect(stats.pending).toBe(0)
    expect(stats.total).toBe(3)
  })

  it('remove and clear drop entries', async () => {
    const journal = new OutboxJournal(() => 1000)
    await journal.append('index', 'a', 's')
    const due = await journal.pendingDue(1000, 100)
    await journal.remove(due[0].id)
    expect((await journal.stats()).total).toBe(0)
    await journal.append('index', 'b', 's')
    await journal.clear()
    expect((await journal.stats()).total).toBe(0)
  })
})

describe('outbox backoff', () => {
  it('grows exponentially and respects the cap', () => {
    const policy = { ...DEFAULT_BACKOFF, baseMs: 100, factor: 2, capMs: 1000 }
    expect(backoffDelayMs(policy, 1)).toBe(100)
    expect(backoffDelayMs(policy, 2)).toBe(200)
    expect(backoffDelayMs(policy, 3)).toBe(400)
    expect(backoffDelayMs(policy, 4)).toBe(800)
    expect(backoffDelayMs(policy, 5)).toBe(1000) // capped
  })
})
