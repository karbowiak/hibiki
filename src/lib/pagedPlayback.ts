import type { MusicTrack, PagedResult } from "../types/music"

export interface CollectionOrder {
  filter: string
  sort: string
  dir: "asc" | "desc"
}

export interface PagedTrackSource {
  key: string
  total?: number
  /** Resolve a cached full-membership order inside the player's selection fence. */
  prepare?: () => Promise<PagedTrackSource | null>
  entries?: readonly Partial<MusicTrack>[]
  loadItems?: (positions: number[]) => Promise<MusicTrack[]>
  restoreQuery?: CollectionOrder & { key: string }
  initialPage?: { offset: number; items: MusicTrack[] }
  loadPage: (offset: number, limit: number) => Promise<PagedResult<MusicTrack>>
}
export function shuffled<T>(items: readonly T[], random = Math.random): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/** Fetch each page once, in random page order for shuffle. Never drains a list to start audio. */
export class TrackQueuePager {
  readonly pageSize = 500
  private visited = new Set<number>()
  private total: number | undefined
  private finished = false
  loaded = 0
  constructor(
    private source: PagedTrackSource,
    readonly shuffle: boolean,
    private random = Math.random,
    private startIndex = 0
  ) {
    this.total = source.total && source.total > 0 ? source.total : undefined
    if (!shuffle)
      for (let i = 0; i < Math.floor(startIndex / this.pageSize); i++)
        this.visited.add(i)
  }
  get hasMore() {
    return (
      !this.finished &&
      (this.total === undefined ||
        this.visited.size < Math.ceil(this.total / this.pageSize))
    )
  }
  get totalCount() {
    return this.total ?? 0
  }
  async next() {
    if (!this.hasMore) return []
    const pages =
      this.total === undefined
        ? [this.visited.size]
        : Array.from(
            { length: Math.ceil(this.total / this.pageSize) },
            (_, i) => i
          ).filter((i) => !this.visited.has(i))
    const page =
      pages[this.shuffle ? Math.floor(this.random() * pages.length) : 0]
    const offset = page * this.pageSize
    const result = await this.source.loadPage(offset, this.pageSize)
    if (
      result.items.length > this.pageSize ||
      (result.offset !== undefined && result.offset !== offset)
    )
      throw Error("The server returned an unexpected queue page. Try again.")
    this.visited.add(page)
    this.loaded += result.items.length
    if (result.total > 0) this.total = result.total
    else if (result.items.length < this.pageSize) {
      this.total = offset + result.items.length
      this.finished = true
    }
    const items = this.shuffle
      ? shuffled(result.items, this.random)
      : result.items.slice(Math.max(0, this.startIndex - offset))
    this.startIndex = 0
    return items
  }
}
