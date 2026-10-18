const listeners = new Set<() => void>()
/** Mutations can wake the read-only activity monitor without owning its lifecycle. */
export function refreshNativeActivity() {
  for (const listener of listeners) listener()
}
export function subscribeNativeActivity(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Coalesce wakes, never overlap polls, and discard responses from retired owners. */
export function monitorActivity<T>(options: {
  current(): boolean
  read(): Promise<T>
  publish(value: T): void
  interval(value?: T): number
  minIntervalMs?: number
}) {
  let stopped = false,
    running = false,
    again = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastRead = -Infinity
  const current = () => !stopped && options.current()
  const schedule = (delay: number) => {
    if (!current()) return
    clearTimeout(timer)
    const remaining =
      (options.minIntervalMs ?? 0) - (performance.now() - lastRead)
    timer = setTimeout(
      () => {
        timer = undefined
        void read()
      },
      Math.max(delay, remaining, 0)
    )
  }
  async function read() {
    if (!current()) return
    if (running) {
      again = true
      return
    }
    running = true
    lastRead = performance.now()
    let value: T | undefined
    try {
      value = await options.read()
      if (current()) options.publish(value)
    } catch {
      /* A status read cannot start, retry or mutate the underlying job. */
    } finally {
      running = false
      if (current()) schedule(again ? 0 : options.interval(value))
      again = false
    }
  }
  return {
    offer() {
      if (running) again = true
      else schedule(0)
    },
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}
