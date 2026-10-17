import type { MusicTrack } from "../types/music"

/** Likes describe provider membership, so equal artist/title never replaces a row. */
export function mergeLikedTrackSources(plex: readonly MusicTrack[], youtube: readonly MusicTrack[]): MusicTrack[] {
  const unique = (tracks: readonly MusicTrack[]) => {
    const seen = new Set<string>()
    return tracks.filter(track => {
      if (seen.has(track.id)) return false
      seen.add(track.id)
      return true
    })
  }
  const local = unique(plex), remote = unique(youtube), rows: MusicTrack[] = []
  for (let index = 0; index < Math.max(local.length, remote.length); index++) {
    if (local[index]) rows.push(local[index])
    if (remote[index]) rows.push(remote[index])
  }
  return rows
}
