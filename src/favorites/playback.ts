import type { MusicProvider } from "../providers/types"
import type { MusicTrack } from "../types/music"
import type { PagedTrackSource } from "../lib/pagedPlayback"
import type { FavoriteState, FavoriteEntry } from "./types"
import { favoriteLikedAt } from "./model"
import { favoriteTracks } from "./collection"

/** Capture membership, not a huge hydrated track array. Playback resolves bounded pages. */
export function favoritePlaybackSource(
  state: FavoriteState,
  rated: MusicTrack[],
  provider: MusicProvider,
  order?: FavoriteEntry[]
): PagedTrackSource {
  const entries =
    order ??
    Object.values(state.entries)
      .filter((item) => item.liked && item.localTrackIds.length)
      .sort(
        (a, b) =>
          (favoriteLikedAt(b) ?? 0) - (favoriteLikedAt(a) ?? 0) ||
          a.id.localeCompare(b.id)
      )
  const seed = new Map(rated.map((track) => [track.id, track]))
  return {
    key: "favorites",
    total: entries.length,
    async loadPage(offset, limit) {
      const selected = entries.slice(offset, offset + limit)
      const ids = [...new Set(selected.flatMap((entry) => entry.localTrackIds))]
      const available = new Map(
        ids.flatMap((id) =>
          seed.has(id) ? [[id, seed.get(id)!] as const] : []
        )
      )
      if (provider.favorites?.cachedTracks) {
        const missing = ids.filter((id) => !available.has(id))
        for (let i = 0; i < missing.length; i += 200) {
          const rows = await provider.favorites.cachedTracks(
            missing.slice(i, i + 200)
          )
          rows.forEach((track) => available.set(track.id, track))
        }
      }
      const missing = selected
        .filter((entry) => !entry.localTrackIds.some((id) => available.has(id)))
        .map((entry) => entry.localTrackIds[0])
      for (let i = 0; i < missing.length; i += 4) {
        const rows = await Promise.allSettled(
          missing.slice(i, i + 4).map((id) => provider.getTrack(id))
        )
        rows.forEach((row) => {
          if (row.status === "fulfilled") available.set(row.value.id, row.value)
        })
      }
      const resolved = favoriteTracks(
        {
          ...state,
          entries: Object.fromEntries(
            selected.map((entry) => [entry.id, entry])
          ),
        },
        available,
        !!provider.isOffline
      )
      const byId = new Map(resolved.map((track) => [track.id, track]))
      const items = selected.map(
        (entry) =>
          entry.localTrackIds.map((id) => byId.get(id)).find(Boolean) ??
          favoriteStub(entry)
      )
      return { items, offset, total: entries.length }
    },
  }
}

export function favoriteStub(entry: FavoriteEntry): MusicTrack {
  const time = favoriteLikedAt(entry)
  return {
    id: entry.localTrackIds[0],
    title: entry.title,
    artistName: entry.artist,
    albumName: entry.album ?? "",
    duration: entry.durationMs ?? 0,
    likedAt: time ? new Date(time).toISOString() : null,
    trackNumber: 0,
    albumId: null,
    albumYear: null,
    artistId: null,
    year: 0,
    playCount: 0,
    thumbUrl: null,
    albumThumbUrl: null,
    artistThumbUrl: null,
    summary: null,
    userRating: null,
    addedAt: null,
    lastPlayedAt: null,
    guid: null,
    codec: null,
    bitrate: null,
    channels: null,
    bitDepth: null,
    samplingRate: null,
    streamUrl: null,
    gain: null,
    albumGain: null,
    peak: null,
    loudness: null,
  }
}
