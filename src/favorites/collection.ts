import type { MusicTrack } from "../types/music"
import type { FavoriteState } from "./types"
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
    .sort((a, b) => b.changedAt - a.changedAt)
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
      return [rows[0]]
    })
}
