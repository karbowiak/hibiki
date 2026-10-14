import type { MusicTrack } from "../types/music"
import type { FavoriteState } from "./types"
import { favoriteLikedAt } from "./model"
const lossless = new Set(["flac", "alac", "wav", "aiff", "dsd"])
export function favoriteTracks(
  state: FavoriteState,
  available: Map<string, MusicTrack>,
  offline = false
): MusicTrack[] {
  const quality = (track: MusicTrack) => {
    const uncompressed = lossless.has(track.codec?.toLowerCase() ?? "")
    return [
      Number(
        offline
          ? track.mediaInfo?.localAudio ||
              track.mediaInfo?.offlineAvailable === true
          : track.mediaInfo?.hasAudioStream !== false
      ),
      Number(uncompressed),
      uncompressed ? (track.bitDepth ?? 16) : 0,
      uncompressed ? (track.samplingRate ?? 44100) : 0,
      track.bitrate ?? 0,
    ]
  }
  const seen = new Set<string>()
  return Object.values(state.entries)
    .filter((item) => item.liked)
    .sort(
      (a, b) =>
        (favoriteLikedAt(b) ?? 0) - (favoriteLikedAt(a) ?? 0) ||
        a.id.localeCompare(b.id)
    )
    .flatMap((item) => {
      const rows = item.localTrackIds
        .map((id) => available.get(id))
        .filter((track): track is MusicTrack => !!track)
      rows.sort((a, b) => {
        const aq = quality(a),
          bq = quality(b)
        for (let i = 0; i < aq.length; i++)
          if (aq[i] !== bq[i]) return bq[i] - aq[i]
        return (
          item.localTrackIds.indexOf(a.id) - item.localTrackIds.indexOf(b.id)
        )
      })
      if (!rows[0] || seen.has(rows[0].id)) return []
      seen.add(rows[0].id)
      const likedAt = favoriteLikedAt(item)
      return [
        {
          ...rows[0],
          likedAt: likedAt ? new Date(likedAt).toISOString() : null,
        },
      ]
    })
}

/** Combine loves and ratings chronologically without using Plex's library-add date. */
export function sortLikedTracks(tracks: MusicTrack[]): MusicTrack[] {
  const time = (track: MusicTrack) => {
    const value = Date.parse(track.likedAt ?? track.lastRatedAt ?? "")
    return Number.isFinite(value) ? value : 0
  }
  return [...tracks].sort(
    (a, b) => time(b) - time(a) || a.id.localeCompare(b.id)
  )
}
