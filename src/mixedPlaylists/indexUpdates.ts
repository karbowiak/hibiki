import { matchingUpdateAffectsRecording } from "../matching/changes"
import type { MatchingUpdate } from "../matching/updates"
import type { MixedPlaylist } from "./model"

/** New index data can fill a missing Plex counterpart or invalidate a retained
 * identity. Unrelated changes and unchanged timers have no work to offer. */
export function playlistNeedsIndexCheck(playlist: MixedPlaylist, update?: MatchingUpdate) {
  return playlist.items.some(row => {
    const plex = row.songs.plex
    if (update && plex && (update.reset || update.coverageChanged || update.changes.some(change =>
      change.kind === "track" && String(change.id) === plex.track.id ||
      change.kind === "album" && String(change.id) === plex.track.albumId ||
      change.kind === "artist" && String(change.id) === plex.track.artistId))) return true
    const source = row.songs[row.original]?.track
    return (!plex || plex.stale) && !!source && (!update || matchingUpdateAffectsRecording(update, source))
  })
}
