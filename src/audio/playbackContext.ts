import type { MusicTrack } from "../types/music"
import type { TrackPlaybackInfo } from "../providers/types"

/** Album intent comes from the UI's Play action, never from queue neighbors. */
export function isAlbumPlayback(
  track: Pick<MusicTrack, "albumId" | "_albumGroupIds">,
  albumPlaybackId: string | null
): boolean {
  return (
    !!albumPlaybackId &&
    (track.albumId === albumPlaybackId ||
      track._albumGroupIds?.includes(albumPlaybackId) === true)
  )
}

/** Scheduler identity for one deliberately selected merged album. Physical
 * source/track IDs still own audio, waveforms, metadata and Plex reporting. */
export function playbackAlbumKey(
  track: Pick<MusicTrack, "albumId" | "_albumGroupIds">,
  physicalKey: string,
  albumPlaybackId: string | null
): string {
  return isAlbumPlayback(track, albumPlaybackId) && track._albumGroupIds?.length
    ? `hibiki-album:${albumPlaybackId}`
    : physicalKey
}

export function selectReplayGain(
  track: Pick<MusicTrack, "albumId" | "_albumGroupIds" | "gain" | "albumGain">,
  albumPlaybackId: string | null
): number | null {
  return isAlbumPlayback(track, albumPlaybackId)
    ? (track.albumGain ?? track.gain)
    : track.gain
}

/** Native preparation may acquire missing gain after the UI's metadata lookup. */
export function preparedReplayGain(
  track: Pick<MusicTrack, "albumId" | "_albumGroupIds">,
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
        _albumGroupIds: track._albumGroupIds,
        gain: finite(info.trackGain),
        albumGain: finite(info.albumGain),
      },
      albumPlaybackId
    ) ?? finite(fallback)
  )
}
