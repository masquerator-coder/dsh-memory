/**
 * Synchronous-budget helper: run a promise but settle on the deadline first.
 * Used so recall never blocks the main session past the configured timeout
 * (§4.1 timeout + degradation).
 *
 * @module dsh-memory/util/timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<never>((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      // eslint-disable-next-line prefer-promise-reject-errors
      reject(new Error(`memory recall timed out after ${ms}ms`))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } catch (error) {
    if (timedOut) return fallback()
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
