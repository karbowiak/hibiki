/** Coalesce reads and retire their publication when a cache is cleared. */
export class CacheRequests {
  private epoch = 0
  private pending = new Map<string, Promise<unknown>>()
  clear() {
    this.epoch++
    this.pending.clear()
  }
  load<T>(
    key: string,
    fetch: () => Promise<T>,
    publish: (value: T) => void
  ): Promise<T | null> {
    const existing = this.pending.get(key)
    if (existing) return existing as Promise<T | null>
    if (this.pending.size >= 64) return Promise.resolve(null)
    const epoch = this.epoch
    const request = Promise.resolve()
      .then(fetch)
      .then((value) => {
        if (epoch !== this.epoch) return null
        publish(value)
        return value
      })
      .catch(() => null)
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key)
      })
    this.pending.set(key, request)
    return request
  }
}
