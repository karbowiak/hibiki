import type { MusicTrack } from "../types/music"

/** Album intent comes from the UI's Play action, never from queue neighbors. */
export function isAlbumPlayback(track: Pick<MusicTrack, "albumId">, albumPlaybackId: string | null): boolean {
  return !!albumPlaybackId && track.albumId === albumPlaybackId
}

export function selectReplayGain(track: Pick<MusicTrack, "albumId" | "gain" | "albumGain">, albumPlaybackId: string | null): number | null {
  return isAlbumPlayback(track, albumPlaybackId) ? (track.albumGain ?? track.gain) : track.gain
}
