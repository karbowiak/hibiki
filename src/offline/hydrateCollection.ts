import type { PlexRequestContext } from "../backends/plex/scopedApi"
import type { MusicItem, MusicPlaylist, PagedResult } from "../types/music"
import { sanitizeOfflineData } from "./providerCache"
export type CollectionSource =
  | { kind: "rated"; item: "track" | "album" | "artist" }
  | { kind: "playlist"; id: string }
  | { kind: "playlists" }
  | { kind: "mix"; path: string }
export interface CollectionHydration {
  context: PlexRequestContext
  key: string
  stamp: string
  force: boolean
  source: CollectionSource
  resume?: { completed: number; total: number }
}
interface Dependencies {
  native<T>(op: string, args: Record<string, unknown>): Promise<T>
  read(method: string, args: unknown[]): Promise<any>
  progress(completed: number, total?: number): void
}
export function collectionIsFresh(info: { complete: boolean; dirty: boolean; refreshing: boolean; stamp: string; cachedAt: number } | null,
  job: { force: boolean; stamp: string }, now = Date.now()) {
  return !job.force && !!info?.complete && !info.dirty && !info.refreshing &&
    info.stamp === job.stamp && now - info.cachedAt < 900000
}
/** Four pages per claim; the caller reoffers a valid unfinished generation. */
export async function hydrateCollection(
  job: CollectionHydration,
  deps: Dependencies
) {
  const call = <T>(op: string, args: Record<string, unknown> = {}) =>
    deps.native<T>(op, args)
  const info = await call<{
    complete: boolean
    dirty: boolean
    refreshing: boolean
    stamp: string
    cachedAt: number
  } | null>("info")
  if (collectionIsFresh(info, job))
    return { done: true, changed: false }
  const token = await call<{ generation: number; offset: number; total?: number }>("begin", {
    stamp: job.stamp,
  })
  let offset = token.offset
  deps.progress(offset, token.total)
  let total = token.total ?? 0
  const roster: MusicPlaylist[] | null =
    job.source.kind === "playlists" ? await deps.read("getPlaylists", []) : null
  for (let page = 0; page < 4; page++) {
    let result: PagedResult<MusicItem>
    switch (job.source.kind) {
      case "rated":
        result = await deps.read("getRatedItemsPage", [
          job.source.item,
          offset,
          500,
        ])
        break
      case "playlist":
        result = await deps.read("getPlaylistItems", [
          job.source.id,
          offset,
          500,
        ])
        break
      case "mix":
        result = await deps.read("getMixTracksPage", [
          job.source.path,
          offset,
          500,
        ])
        break
      case "playlists":
        result = {
          items: roster!
            .slice(offset, offset + 500)
            .map((item) => ({ ...item, type: "playlist" })),
          total: roster!.length,
          offset,
        }
        break
    }
    if (job.source.kind === "playlist" || job.source.kind === "mix")
      result = {
        ...result,
        items: result.items.map((item) => ({
          ...item,
          type: "track" as const,
        })) as MusicItem[],
      }
    if (result.offset !== undefined && result.offset !== offset)
      throw Error("Collection paging did not advance")
    total = result.total || offset + result.items.length
    if (result.items.length > 500 || (!result.items.length && offset < total))
      throw Error("Collection changed while caching")
    await call("put", {
      generation: token.generation,
      offset,
      total,
      items: sanitizeOfflineData(result.items),
    })
    offset += result.items.length
    deps.progress(offset, total)
    if (offset >= total) {
      const result = await call<{ changed: boolean }>("commit", {
        generation: token.generation,
      })
      return { done: true, changed: result.changed }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { done: false, changed: false, resume: { completed: offset, total } }
}
