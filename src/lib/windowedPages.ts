import type { PagedResult } from "../types/music"

export interface WindowedCollection<T> {
  total: number
  getItem(index: number): T | undefined
  ensureRange(start: number, end: number): void
  retry(): void
  error: string
  loading: boolean
}

/** A bounded page cache: scroll position is independent of which pages are resident. */
export class WindowedPages<T> implements WindowedCollection<T> {
  readonly pageSize = 200
  readonly maxPages = 8
  private pages = new Map<number, T[]>()
  private pending = new Map<number, number>()
  private generation = 0
  private wanted: number[] = [0]
  private failures = new Set<number>()
  private stale = new Set<number>()
  private listeners = new Set<() => void>()
  private revision = 0
  private sourceVersion: unknown = undefined
  total: number
  error = ""
  loading = true
  constructor(
    private load: (offset: number, limit: number) => Promise<PagedResult<T>>,
    total = 0
  ) {
    this.total = total
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.revision
  private publish() {
    this.loading = this.pending.size > 0
    this.revision++
    this.listeners.forEach((listener) => listener())
  }
  getItem = (index: number) =>
    this.pages.get(Math.floor(index / this.pageSize))?.[index % this.pageSize]
  get residentCount() {
    return [...this.pages.values()].reduce(
      (sum, items) => sum + items.length,
      0
    )
  }
  get initialized() {
    return this.pages.size > 0
  }
  get loadedItems() {
    return [...this.pages.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([, items]) => items)
  }
  ensureRange = (start: number, end: number) => {
    const first = Math.floor(Math.max(0, start) / this.pageSize)
    const last = Math.floor(Math.max(start, end - 1) / this.pageSize)
    this.wanted = Array.from(
      { length: Math.min(this.maxPages, last - first + 1) },
      (_, i) => first + i
    )
    // Prefetch before reaching the next page, without walking the whole collection.
    if (
      end % this.pageSize > this.pageSize - 50 &&
      this.wanted.length < this.maxPages &&
      (last + 1) * this.pageSize < this.total
    )
      this.wanted.push(last + 1)
    for (const page of this.wanted) {
      const items = this.pages.get(page)
      if (items) {
        this.pages.delete(page)
        this.pages.set(page, items)
      }
    }
    this.pump()
  }
  retry = () => {
    this.failures.clear()
    this.error = ""
    this.pump()
    this.publish()
  }
  updateSource(
    load: (offset: number, limit: number) => Promise<PagedResult<T>>,
    total: number,
    version: unknown
  ) {
    if (this.sourceVersion === version) return
    this.sourceVersion = version
    this.load = load
    this.total = total
    if (!total) this.wanted = [0]
    // A sync changes membership, not the identity of the view. Retain visible rows
    // until their replacements arrive; only genuinely missing chunks need skeletons.
    if (this.pages.size || this.pending.size) this.invalidate()
    else this.publish()
  }
  invalidate = () => {
    this.generation++
    this.stale = new Set(this.pages.keys())
    this.failures.clear()
    this.error = ""
    this.pump()
    this.publish()
  }
  private pump() {
    for (const page of this.wanted) {
      if (this.pending.size >= 2) break
      if (
        (this.pages.has(page) && !this.stale.has(page)) ||
        this.pending.has(page) ||
        this.failures.has(page)
      )
        continue
      if (this.total > 0 && page * this.pageSize >= this.total) continue
      const generation = this.generation
      this.pending.set(page, generation)
      this.publish()
      void this.load(page * this.pageSize, this.pageSize)
        .then((result) => {
          if (generation !== this.generation) return
          const offset = page * this.pageSize
          if (
            result.items.length > this.pageSize ||
            (result.offset !== undefined && result.offset !== offset)
          )
            throw Error("The server returned an unexpected page. Try again.")
          if (
            result.total > offset + result.items.length &&
            result.items.length < this.pageSize
          )
            throw Error("The server returned an incomplete page. Try again.")
          this.total =
            result.total > 0
              ? result.total
              : !result.items.length && offset === 0
                ? 0
                : this.total || offset + result.items.length
          this.pages.set(page, result.items)
          this.stale.delete(page)
          while (this.pages.size > this.maxPages) {
            const oldest =
              [...this.pages.keys()].find(
                (key) => !this.wanted.includes(key)
              ) ?? this.pages.keys().next().value!
            this.pages.delete(oldest)
          }
        })
        .catch((error) => {
          if (generation !== this.generation) return
          this.failures.add(page)
          this.error =
            error instanceof Error
              ? error.message
              : "Could not load this section. Try again."
        })
        .finally(() => {
          if (this.pending.get(page) === generation) {
            this.pending.delete(page)
            this.publish()
            this.pump()
          }
        })
    }
  }
}
