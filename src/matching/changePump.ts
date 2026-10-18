import type { MatchingChanges } from "./resolverTypes"

/** Coalesce native page notifications and read a bounded change tail. A reset
 * means the retained tail is shorter than our cursor, never that data vanished. */
export function createMatchingChangePump(options: {
  current: () => boolean
  read: (cursor: number) => Promise<MatchingChanges>
  publish: (update: MatchingChanges & { coverageChanged: boolean }) => void
  delay?: number
}) {
  let cursor = Number.MAX_SAFE_INTEGER, coverage = "", running = false, again = false, stopped = false, failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const current = () => !stopped && options.current()
  const schedule = (delay = options.delay ?? 500) => {
    if (!current()) return
    if (running) { again = true; return }
    if (timer) return
    timer = setTimeout(() => { timer = undefined; void drain() }, delay)
  }
  async function drain() {
    if (!current() || running) return
    running = true; again = false
    try {
      const changes: MatchingChanges["changes"] = []
      let reset = false, coverageChanged = false, revision = cursor
      for (let page = 0; page < 3 && current(); page++) {
        const result = await options.read(cursor)
        if (!current()) return
        if (result.changes.length > 200 || result.cursor < 0 || (!result.reset && result.cursor < cursor)) throw Error("Invalid matching change cursor")
        reset ||= result.reset
        coverageChanged ||= coverage !== result.coverage
        coverage = result.coverage
        cursor = result.cursor; revision = result.revision
        changes.push(...result.changes)
        if (cursor >= revision) break
        if (page === 2) again = true
      }
      failures = 0
      if (current() && (reset || coverageChanged || changes.length)) options.publish({ cursor, revision, coverage, reset, changes, coverageChanged })
    } catch {
      failures++
      again = true
    } finally {
      running = false
      if (again && current()) schedule(failures ? Math.min(30000, 1000 * 2 ** Math.min(failures, 5)) : undefined)
    }
  }
  return { offer: () => schedule(), stop: () => { stopped = true; if (timer) clearTimeout(timer) } }
}
