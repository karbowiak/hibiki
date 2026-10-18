import type { MatchingUpdate } from "./updates"

/** One bounded, coalescing consumer lane. Native page events never enqueue an
 * unbounded chain of rating/playlist jobs behind a slower fresh preflight. */
export function createMatchingConsumer(run: (update?: MatchingUpdate) => Promise<void>, delay = 500) {
  let stopped = false, running = false, pending = false
  let next: MatchingUpdate | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const drain = async () => {
    timer = undefined
    if (stopped || running || !pending) return
    const update = next; next = undefined; pending = false; running = true
    try { await run(update) } catch { /* Durable consumer state retains failures. */ }
    finally { running = false; if (!stopped && pending) timer = setTimeout(drain, delay) }
  }
  return {
    offer(update?: MatchingUpdate) {
      if (stopped) return
      if (pending && (!update || !next)) next = undefined
      else if (update && next && next.provider === update.provider) {
        const changes = [...next.changes, ...update.changes]
        next = { ...update, reset: next.reset || update.reset || changes.length > 1000,
          coverageChanged: next.coverageChanged || update.coverageChanged, changes: changes.slice(-1000) }
      } else next = update
      pending = true
      if (!running && !timer) timer = setTimeout(drain, delay)
    },
    stop() { stopped = true; pending = false; next = undefined; if (timer) clearTimeout(timer) },
  }
}
