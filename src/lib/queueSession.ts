import type { MusicTrack } from "../types/music"
import type { PagedTrackSource } from "./pagedPlayback"
import { shuffled } from "./pagedPlayback"

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
  private pending = new Map<number, Promise<void>>()
  private hydrated = new Map<number, MusicTrack>()
  private pages = new Map<number, Promise<MusicTrack[]>>()
  private serial = Promise.resolve()
  constructor(source: PagedTrackSource, shuffle = false) {
    this.source = source
    const total = source.entries?.length ?? source.total ?? 0
    const members = Array.from({ length: total }, (_, index) =>
      this.stub(index)
    )
    this.entries = shuffle ? shuffled(members) : members
    if (source.initialPage) {
      const { offset, items } = source.initialPage
      items.forEach((track, index) => this.hydrated.set(offset + index, track))
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
  async ensure(queue: MusicTrack[], start: number, end: number) {
    const wanted = queue
      .slice(Math.max(0, start), Math.min(queue.length, end))
      .flatMap((track) => {
        const item = track as Member
        return item[position] !== undefined && item[placeholder]
          ? [item[position]!]
          : []
      })
    const missing = [...new Set(wanted)].filter(
      (index) => !this.hydrated.has(index) && !this.pending.has(index)
    )
    for (let offset = 0; offset < missing.length; offset += 100) {
      const selected = missing.slice(offset, offset + 100)
      const work = this.serial
        .catch(() => {})
        .then(async () => {
          const rows = await this.load(selected)
          if (rows.length !== selected.length)
            throw Error("Some queued songs could not be loaded. Try again.")
          rows.forEach((track, index) => {
            this.hydrated.delete(selected[index])
            this.hydrated.set(selected[index], track)
          })
          while (this.hydrated.size > 800)
            this.hydrated.delete(this.hydrated.keys().next().value!)
        })
      this.serial = work
      selected.forEach((index) => this.pending.set(index, work))
      void work
        .finally(() => selected.forEach((index) => this.pending.delete(index)))
        .catch(() => {})
    }
    await Promise.all(wanted.map((index) => this.pending.get(index)))
  }
  project(queue: MusicTrack[], protectedIndex: number) {
    let changed = false
    const result = queue.map((track, index) => {
      const sourceIndex = (track as Member)[position]
      if (sourceIndex === undefined) return track
      const detail = this.hydrated.get(sourceIndex)
      if (detail && (track as Member)[placeholder]) {
        changed = true
        return { ...detail, [position]: sourceIndex } as Member
      }
      if (
        !detail &&
        !(track as Member)[placeholder] &&
        Math.abs(index - protectedIndex) > 4
      ) {
        changed = true
        return this.stub(sourceIndex)
      }
      return track
    })
    return changed ? result : queue
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
