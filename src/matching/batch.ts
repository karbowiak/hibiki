import type { MatchingSource, MatchingResolution } from "./resolverTypes"

/** One small native batch for simultaneous visible/queued requests. Completed
 * results stay in the revision-aware native store, not an expanding renderer map. */
export function createMatchingBatch(options: {
  current: () => boolean
  lookup: (sources: MatchingSource[], force: boolean) => Promise<MatchingResolution[]>
  fallback?: (source: MatchingSource) => Promise<MatchingResolution>
  delay?: number
}) {
  type Pending = { source: MatchingSource; force: boolean; live: boolean; promise: Promise<MatchingResolution>; resolve: (value: MatchingResolution) => void; reject: (error: Error) => void }
  const pending = new Map<string, Pending>()
  const fallbackAt = new Map<string, number>()
  const waiting: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined, running = 0
  let fallbackRunning = 0
  const fallbackQueue: (() => void)[] = []
  async function withFallback(work: () => Promise<MatchingResolution>) {
    if (fallbackRunning >= 2) {
      if (fallbackQueue.length >= 32) return null
      await new Promise<void>(resolve => fallbackQueue.push(resolve))
    } else fallbackRunning++
    try { current(); return await work() }
    finally {
      const next = fallbackQueue.shift()
      if (next) next(); else fallbackRunning--
    }
  }
  const current = () => { if (!options.current()) throw Error("Music matching owner changed.") }
  function schedule() {
    if (!timer && running < 2 && waiting.length) timer = setTimeout(() => { timer = undefined; void flush() }, options.delay ?? 8)
  }
  async function flush() {
    if (running >= 2 || !waiting.length) return
    const first = pending.get(waiting[0])!
    const keys: string[] = []
    for (let index = 0; index < waiting.length && keys.length < 16;) {
      if (pending.get(waiting[index])!.force === first.force) keys.push(...waiting.splice(index, 1))
      else index++
    }
    const work = keys.map(key => pending.get(key)!)
    running++
    let released = false
    schedule()
    try {
      current()
      const results = await options.lookup(work.map(item => item.source), first.force)
      current()
      if (results.length !== work.length || results.some((result, index) => result.sourceId !== work[index].source.id))
        throw Error("Matching returned a different batch. Please retry.")
      // Provider fallbacks have their own two lanes. A slow unresolved identity
      // must not hold already verified replies or either native lookup lane.
      running--; released = true; schedule()
      // Keep a bounded fallback lane. Each batch has at most 16 items and each
      // native fallback has its own request/response and concurrency limits.
      await Promise.all(work.map(async (item, index) => {
        let result = results[index]
        const fallbackKey = JSON.stringify(item.source)
        const due = item.force || Date.now() - (fallbackAt.get(fallbackKey) ?? 0) >= 60000
        if (item.live && options.fallback && due && !["matched", "ambiguous"].includes(result.status) && (result.status !== "missing" || item.force) && (!result.cached || item.force)) {
          try {
            const found = await withFallback(async () => {
              fallbackAt.delete(fallbackKey)
              fallbackAt.set(fallbackKey, Date.now())
              while (fallbackAt.size > 256) fallbackAt.delete(fallbackAt.keys().next().value!)
              return options.fallback!(item.source)
            })
            if (found) result = found
            current()
          }
          catch (error) {
            current()
            result = { ...result, status: "provider-error", selected: null }
          }
        }
        current()
        item.resolve(result)
        if (pending.get(keys[index]) === item) pending.delete(keys[index])
      }))
    } catch (failure) {
      const error = failure instanceof Error ? failure : Error("Matching lookup failed. Please retry.")
      for (let index = 0; index < work.length; index++) { work[index].reject(error); if (pending.get(keys[index]) === work[index]) pending.delete(keys[index]) }
    } finally { if (!released) running--; schedule() }
  }
  return (source: MatchingSource, force = false, live = true): Promise<MatchingResolution> => {
    try { current() } catch (error) { return Promise.reject(error) }
    const key = JSON.stringify([source, force, live])
    const active = pending.get(key)
    if (active) return active.promise
    if (pending.size >= 256) return Promise.reject(Error("Matching is busy. Please retry shortly."))
    let resolve!: Pending["resolve"], reject!: Pending["reject"]
    const promise = new Promise<MatchingResolution>((ok, fail) => { resolve = ok; reject = fail })
    pending.set(key, { source: structuredClone(source), force, live, promise, resolve, reject })
    waiting.push(key)
    schedule()
    return promise
  }
}
