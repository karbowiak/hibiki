import type { MusicProvider } from "../providers/types"
import type { MusicTrack } from "../types/music"
import type { DjMode } from "../stores/playerStore"

/** Keep only items that have actual audio (at least one media part with a key). */
export function filterPlayable(tracks: MusicTrack[]): MusicTrack[] {
  return tracks.filter((t) => t.mediaInfo?.hasAudioStream)
}

/** Reads a DJ strategy; the caller owns admission and queue publication. */
export async function selectDjTracks({
  provider,
  mode,
  currentTrack,
  queue,
  queueIndex,
  generated,
  current,
}: {
  provider: MusicProvider
  mode: DjMode
  currentTrack: MusicTrack
  queue: MusicTrack[]
  queueIndex: number
  generated: ReadonlySet<string>
  current: () => boolean
}): Promise<MusicTrack[]> {
  const existingKeys = new Set(queue.map((track) => track.id))
  let picks: MusicTrack[] = []
  switch (mode) {
    case "freeze": {
      // Sonically similar tracks seeded from the current track
      if (!provider.createRadioQueue) break
      const result = await provider.createRadioQueue(currentTrack.id, "track")
      picks = filterPlayable(result.tracks)
        .filter((t) => !existingKeys.has(t.id))
        .slice(0, 1)
      break
    }

    case "twin": {
      // Most sonically similar track
      if (!provider.createSmartShuffleQueue) break
      const result = await provider.createSmartShuffleQueue(
        currentTrack.id,
        "track",
        "twin"
      )
      picks = filterPlayable(result.tracks)
        .filter((t) => !existingKeys.has(t.id))
        .slice(0, 1)
      break
    }

    case "stretch": {
      // Sonic adventure between current track and the next original (non-DJ) track
      const nextOriginal = queue
        .slice(queueIndex + 1)
        .find((t) => !generated.has(t.id))
      if (nextOriginal && provider.computeSonicPath) {
        try {
          const pathTracks = await provider.computeSonicPath(
            currentTrack.id,
            nextOriginal.id
          )
          picks = filterPlayable(pathTracks).filter(
            (t) =>
              !existingKeys.has(t.id) &&
              t.id !== currentTrack.id &&
              t.id !== nextOriginal.id
          )
        } catch {
          if (!current()) return []
          // Sonic path unavailable — fall back to smart shuffle
          if (provider.createSmartShuffleQueue) {
            const result = await provider.createSmartShuffleQueue(
              currentTrack.id,
              "track",
              "stretch"
            )
            picks = filterPlayable(result.tracks)
              .filter((t) => !existingKeys.has(t.id))
              .slice(0, 2)
          }
        }
      } else if (provider.createSmartShuffleQueue) {
        // No next original track — use smart shuffle for a couple of bridge tracks
        const result = await provider.createSmartShuffleQueue(
          currentTrack.id,
          "track",
          "stretch"
        )
        picks = filterPlayable(result.tracks)
          .filter((t) => !existingKeys.has(t.id))
          .slice(0, 2)
      }
      break
    }

    case "twofer": {
      // Same-artist track
      const artistId = currentTrack.artistId
      if (artistId && provider.getArtistPopularTracksInSection) {
        const tracks = await provider.getArtistPopularTracksInSection(
          artistId,
          10
        )
        const available = tracks.filter(
          (t) => t.id !== currentTrack.id && !existingKeys.has(t.id)
        )
        if (available.length > 0) {
          picks = [available[Math.floor(Math.random() * available.length)]]
        }
      }
      break
    }

    case "anno": {
      // Same era track
      if (!provider.createSmartShuffleQueue) break
      const result = await provider.createSmartShuffleQueue(
        currentTrack.id,
        "track",
        "anno"
      )
      picks = filterPlayable(result.tracks)
        .filter((t) => !existingKeys.has(t.id))
        .slice(0, 1)
      break
    }

    case "groupie": {
      // Same artist via artist radio
      const artistId = currentTrack.artistId
      if (artistId && provider.createRadioQueue) {
        const result = await provider.createRadioQueue(artistId, "artist")
        picks = filterPlayable(result.tracks)
          .filter((t) => !existingKeys.has(t.id))
          .slice(0, 1)
      }
      break
    }
  }

  return current() ? picks : []
}
