/**
 * Synchronous-budget helper: run a promise but settle on the deadline first.
 * Used so recall never blocks the main session past the configured timeout
 * (§4.1 timeout + degradation).
 *
 * `onTimeout` fires exactly when the deadline wins — the honest signal for a
 * degradation counter. Comparing the measured elapsed time against the budget
 * instead is racy (a fast path that merely ran long would be counted) and can
 * miss a real timeout by sub-millisecond rounding.
 *
 * @module dsh-memory/util/timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: () => T | Promise<T>,
  onTimeout?: () => void,
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
    if (timedOut) {
      onTimeout?.()
      return fallback()
    }
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
