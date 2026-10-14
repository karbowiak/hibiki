import { invoke } from "@tauri-apps/api/core"
import type { PlexRequestContext } from "../backends/plex/scopedApi"
import type { PlexMedia } from "../backends/plex/types"
import {
  plexMediaToMusicItem,
  type ImgResolver,
} from "../backends/plex/mappers"
import { buildPlexImageUrl } from "../backends/plex/imageUrl"
import { sanitizeOfflineData, type OfflineSnapshot } from "./providerCache"
import type { MusicTrack } from "../types/music"
import { startTiming } from "../lib/performance"

export interface CatalogueTask {
  task: string
  generation: string
  status: string
  cursor: number
  total: number | null
  completedAt: number | null
  error: string | null
  scanMode?: "keyset" | "offset"
  keyCursor?: number
  upperId?: number | null
  startedAt?: number | null
}
export interface CatalogueProgress {
  tasks: CatalogueTask[]
  entities: number
  details: number
  waveforms: number
  analysisPending: number
  analysisUnavailable: number
  incremental?: {
    pending: number
    catchUpRequested: boolean
    watermark: number | null
    changesRevision: number
    phase: string
  }
}
export interface CatalogueChange {
  id: number
  type: 8 | 9 | 10 | 15
  state: 0 | 1 | 5 | 9
}
/** Events are hints; native code verifies identity and reads authoritative Plex data. */
export const catalogueNotify = (
  context: PlexRequestContext,
  changes: CatalogueChange[],
  catchUp = false
) => invoke<void>("catalogue_notify", { context, changes, catchUp })
export const catalogueStart = (context: PlexRequestContext) =>
  invoke<void>("catalogue_start", { context })
export const catalogueHealth = (context: PlexRequestContext) =>
  invoke<boolean>("catalogue_health", { context })
export const catalogueProgress = (context: PlexRequestContext) =>
  invoke<CatalogueProgress>("catalogue_progress", { context })
export const catalogueRetry = (context: PlexRequestContext, reset = false) =>
  invoke<void>("catalogue_retry", { context, reset })
export async function catalogueRead(
  context: PlexRequestContext,
  baseUrl: string,
  key: string
): Promise<(OfflineSnapshot & { catalogueComplete?: boolean }) | null> {
  const [, method, args] = JSON.parse(key) as [string, string, unknown[]]
  const timing = startTiming(method)
  try {
    const decoded = args.map((value) =>
      value && typeof value === "object" && "$undefined" in value ? null : value
    )
    const page = await invoke<{
      items: PlexMedia[]
      total: number
      cachedAt: number
      complete: boolean
      serverTotal: number | null
    } | null>("catalogue_query", { context, method, args: decoded })
    timing.phase("catalogue_ipc")
    if (!page) return null
    if (method === "getTags")
      return {
        payload: page.items,
        cachedAt: page.cachedAt,
        catalogueComplete: page.complete,
      }
    const img: ImgResolver = (path, type, id, name, artist) =>
      buildPlexImageUrl(
        baseUrl,
        "native-owned",
        type,
        id,
        path,
        name,
        artist,
        context.cacheScope
      ) ?? ""
    const items = page.items
      .map((item) => plexMediaToMusicItem(item, img))
      .filter((item) => item !== null)
    let payload: unknown = items
    if (["getTrack", "getAlbum", "getArtist"].includes(method)) {
      if (!items[0]) return null
      payload = items[0]
    } else if (
      method.startsWith("getAll") ||
      method === "getPlaylistItems" ||
      method === "getItemsByTag"
    )
      payload = {
        items,
        total: page.total,
        localCoverageComplete: page.complete,
        serverTotal: page.serverTotal,
        offset:
          decoded[
            method === "getPlaylistItems"
              ? 1
              : method === "getItemsByTag"
                ? 4
                : 0
          ] ?? 0,
      }
    return {
      payload: sanitizeOfflineData(payload),
      cachedAt: page.cachedAt,
      catalogueComplete: page.complete,
    }
  } finally {
    timing.end("catalogue_map")
  }
}
/** One IPC for a whole visible page; actual complete cache files decide admission. */
export async function projectOfflineAvailability(
  context: PlexRequestContext,
  payload: unknown
): Promise<unknown> {
  const tracks: MusicTrack[] = []
  const groups: {
    kind: "album" | "artist" | "playlist"
    id: string
    item: Record<string, unknown>
  }[] = []
  function collect(value: unknown) {
    if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === "object") {
      const item = value as Record<string, unknown>
      if (typeof item.id === "string" && typeof item.title === "string") {
        if ("trackNumber" in item) tracks.push(item as unknown as MusicTrack)
        else {
          const kind =
            "smart" in item
              ? "playlist"
              : "artistName" in item
                ? "album"
                : "artist"
          if (
            /^\d+$/.test(item.id) &&
            Number.isSafeInteger(Number(item.id)) &&
            Number(item.id) > 0
          )
            groups.push({ kind, id: item.id, item })
          else item.offlineAvailable = false
        }
      } else if ("items" in item) collect(item.items)
    }
  }
  collect(payload)
  if (!tracks.length && !groups.length) return payload
  const ids = [
    ...new Set(
      tracks
        .map((track) => Number(track.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    ),
  ]
  const available = new Set<number>()
  for (let start = 0; start < ids.length; start += 1000)
    for (const id of await invoke<number[]>("audio_availability", {
      context,
      trackIds: ids.slice(start, start + 1000),
    }))
      available.add(id)
  for (const track of tracks)
    track.mediaInfo = {
      ...track.mediaInfo,
      offlineAvailable: available.has(Number(track.id)),
    }
  for (let start = 0; start < groups.length; start += 1000) {
    const batch = groups.slice(start, start + 1000)
    const result = await invoke<
      { kind: string; id: string; available: boolean }[]
    >("catalogue_availability", {
      context,
      items: batch.map(({ kind, id }) => ({ kind, id })),
    })
    const available = new Map(
      result.map((item) => [`${item.kind}:${item.id}`, item.available])
    )
    for (const { kind, id, item } of batch)
      item.offlineAvailable = available.get(`${kind}:${id}`) === true
  }
  return payload
}
