import type { MusicTrack } from "../types/music"
import type { PagedTrackSource } from "./pagedPlayback"
import { shuffled } from "./pagedPlayback"
import { QueueHydration, type QueueLoadOptions } from "./queueHydration"

const position = Symbol("queueSourcePosition")
const placeholder = Symbol("queuePlaceholder")
type Member = MusicTrack & { [position]?: number; [placeholder]?: boolean }
export const isQueuePlaceholder = (track: MusicTrack) =>
  !!(track as Member)[placeholder]
export const queueSourcePosition = (track: MusicTrack) =>
  (track as Member)[position]
export const queueMemberKey = (track: MusicTrack, fallback: number) =>
  `${(track as Member)[position] ?? fallback}:${track.playlistItemId ?? track.id}`

export interface SavedQueueEntry {
  id: string
  title?: string
  artistName?: string
  albumName?: string
  duration?: number
  playlistItemId?: string
  sourceIndex?: number
}
export interface SavedQueueState {
  index: number
  positionMs: number
  contextName: string | null
  contextHref: string | null
  albumPlaybackId: string | null
  shuffle: boolean
  repeat: 0 | 1 | 2
  sourceKey?: string
  sourceQuery?: PagedTrackSource["restoreQuery"]
}
export interface SavedQueue {
  entries: SavedQueueEntry[]
  state: SavedQueueState
}
export interface SavedQueueStorage {
  load(): Promise<SavedQueue | null>
  save(value: SavedQueue): Promise<void>
  position(state: SavedQueueState): Promise<void>
  clear(): Promise<void>
}

/** Complete membership stays lightweight; only visited/upcoming metadata is resident. */
export class QueueSession {
  readonly source: PagedTrackSource
  readonly entries: Member[]
  private hydration = new QueueHydration(positions => this.load(positions))
  private indexedQueue: MusicTrack[] | null = null
  private indices: Int32Array
  private duplicates = new Map<number, number[]>()
  private projected = new Set<number>()
  private pages = new Map<number, Promise<MusicTrack[]>>()
  constructor(source: PagedTrackSource, shuffle = false) {
    this.source = source
    const total = source.entries?.length ?? source.total ?? 0
    const members = Array.from({ length: total }, (_, index) =>
      this.stub(index)
    )
    this.entries = shuffle ? shuffled(members) : members
    this.indices = new Int32Array(total)
    if (source.initialPage) {
      const { offset, items } = source.initialPage
      items.forEach((track, index) => this.hydration.items.set(offset + index, track))
      if (offset % 200 === 0 && items.length <= 200)
        this.pages.set(offset / 200, Promise.resolve(items))
    }
  }
  private stub(index: number): Member {
    const entry = this.source.entries?.[index]
    return {
      id: entry?.id ?? `pending:${index}`,
      title: entry?.title ?? "",
      artistName: entry?.artistName ?? "",
      albumName: entry?.albumName ?? "",
      duration: entry?.duration ?? 0,
      playlistItemId: entry?.playlistItemId,
      thumbUrl: entry?.thumbUrl ?? null,
      [position]: index,
      [placeholder]: true,
    } as Member
  }
  private async load(positions: number[]) {
    if (this.source.loadItems) return this.source.loadItems(positions)
    const found = new Map<number, MusicTrack>()
    for (const page of new Set(
      positions.map((index) => Math.floor(index / 200))
    )) {
      const needed =
        Math.max(
          ...positions
            .filter((index) => Math.floor(index / 200) === page)
            .map((index) => index % 200)
        ) + 1
      let request = this.pages.get(page)
      const existing = request ? await request : []
      if (existing.length < needed) {
        request = (async () => {
          const rows: MusicTrack[] = [...existing]
          while (rows.length < needed) {
            const offset = page * 200 + rows.length
            const result = await this.source.loadPage(
              offset,
              needed - rows.length
            )
            if (
              (result.offset !== undefined && result.offset !== offset) ||
              result.items.length > needed - rows.length
            )
              throw Error("Unexpected queue page. Try again.")
            rows.push(...result.items)
            if (
              !result.items.length ||
              (result.total > 0 && page * 200 + rows.length >= result.total)
            )
              break
          }
          return rows
        })()
        this.pages.set(page, request)
        while (this.pages.size > 8)
          this.pages.delete(this.pages.keys().next().value!)
        void request.catch(() => this.pages.delete(page))
      }
      const rows = await request!
      positions
        .filter((index) => Math.floor(index / 200) === page)
        .forEach((index) => {
          if (rows[index % 200]) found.set(index, rows[index % 200])
        })
    }
    return positions.map((index) => found.get(index)!).filter(Boolean)
  }
  retire() { this.hydration.retire() }
  ensure(queue: MusicTrack[], start: number, end: number, options?: QueueLoadOptions) {
    const wanted = queue
      .slice(Math.max(0, start), Math.min(queue.length, end))
      .flatMap(track => {
        const member = track as Member
        return member[position] !== undefined && member[placeholder] ? [member[position]!] : []
      })
    return this.hydration.ensure(wanted, options)
  }
  project(queue: MusicTrack[], protectedIndex: number) {
    if (this.indexedQueue !== queue) {
      this.indices.fill(-1)
      this.duplicates.clear()
      this.projected.clear()
      queue.forEach((track, index) => {
        const source = (track as Member)[position]
        if (source === undefined || source < 0 || source >= this.indices.length) return
        const previous = this.indices[source]
        if (previous >= 0) {
          const indices = this.duplicates.get(source) ?? [previous]
          indices.push(index)
          this.duplicates.set(source, indices)
        } else this.indices[source] = index
        if (!(track as Member)[placeholder]) this.projected.add(source)
      })
      this.indexedQueue = queue
    }
    let result = queue
    // Only resident metadata and its evictions need visiting. Compact cold
    // membership is indexed once per structural queue change.
    for (const source of new Set([...this.projected, ...this.hydration.items.keys()])) {
      const detail = this.hydration.items.get(source)
      const indices = this.duplicates.get(source) ?? [this.indices[source]]
      let projected = false
      for (const index of indices) {
        if (index < 0) continue
        const track = result[index] as Member
        let next = track
        if (detail && track[placeholder]) next = { ...detail, [position]: source }
        else if (!detail && !track[placeholder] && Math.abs(index - protectedIndex) > 4)
          next = this.stub(source)
        if (!next[placeholder]) projected = true
        if (next !== track) {
          if (result === queue) result = queue.slice()
          result[index] = next
        }
      }
      if (projected) this.projected.add(source)
      else this.projected.delete(source)
    }
    this.indexedQueue = result
    return result
  }
  snapshot(queue: MusicTrack[]): SavedQueueEntry[] {
    return queue.map((track) => {
      const sourceIndex = (track as Member)[position]
      return {
        id: track.id.startsWith("pending:") ? "" : track.id,
        title: track.title || undefined,
        artistName: track.artistName || undefined,
        albumName: track.albumName || undefined,
        duration: track.duration || undefined,
        playlistItemId: track.playlistItemId ?? undefined,
        sourceIndex:
          sourceIndex === undefined
            ? undefined
            : ((
                this.source.entries?.[sourceIndex] as
                  SavedQueueEntry | undefined
              )?.sourceIndex ?? sourceIndex),
      }
    })
  }
}
