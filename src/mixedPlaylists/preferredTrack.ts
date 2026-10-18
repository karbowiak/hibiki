import { compareTrackQuality } from "../lib/dedup"
import type { MixedOccurrence } from "./model"

/** Prefer known audio quality, with Plex as the tie-breaker when YTM has not
 * supplied format metadata yet. The track ID also drives its source badge. */
export function preferredMixedReference(row: MixedOccurrence) {
  const plex = !row.songs.plex?.stale ? row.songs.plex : undefined
  const youtube = !row.songs.ytmusic?.stale ? row.songs.ytmusic : undefined
  return (plex && youtube ? compareTrackQuality(youtube.track, plex.track) > 0 ? youtube : plex : plex ?? youtube ?? row.songs[row.original])!
}
