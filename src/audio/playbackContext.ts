import type { MusicTrack } from "../types/music"
import type { TrackPlaybackInfo } from "../providers/types"

/** Album intent comes from the UI's Play action, never from queue neighbors. */
export function isAlbumPlayback(
  track: Pick<MusicTrack, "albumId">,
  albumPlaybackId: string | null
): boolean {
  return !!albumPlaybackId && track.albumId === albumPlaybackId
}

export function selectReplayGain(
  track: Pick<MusicTrack, "albumId" | "gain" | "albumGain">,
  albumPlaybackId: string | null
): number | null {
  return isAlbumPlayback(track, albumPlaybackId)
    ? (track.albumGain ?? track.gain)
    : track.gain
}

/** Native preparation may acquire missing gain after the UI's metadata lookup. */
export function preparedReplayGain(
  track: Pick<MusicTrack, "albumId">,
  info: Pick<TrackPlaybackInfo, "trackGain" | "albumGain">,
  albumPlaybackId: string | null,
  fallback: number | null
): number | null {
  const finite = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null
  return (
    selectReplayGain(
      {
        albumId: track.albumId,
        gain: finite(info.trackGain),
        albumGain: finite(info.albumGain),
      },
      albumPlaybackId
    ) ?? finite(fallback)
  )
}
