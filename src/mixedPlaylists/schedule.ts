import { counterpartPending } from "./matching"
import { playlistServices, type MixedPlaylist } from "./model"

export const PLAYLIST_CHECK_INTERVAL = 60 * 60_000
export const PLAYLIST_CONTINUATION_INTERVAL = 15_000

/** Finish bounded new work promptly. Settled misses and unconfirmed writes
 * wait for the hourly upstream check; neither reopens a matching batch. */
export function nextPlaylistSyncAt(playlist: MixedPlaylist, attemptedAt = 0) {
  const checkedAt = Math.max(playlist.syncCheckedAt ?? 0, attemptedAt)
  const services = playlistServices(playlist)
  const continuing = playlist.merge?.pending || playlist.items.some(row =>
    services.some(service => counterpartPending(row, service))) ||
    playlist.status === "syncing" && !playlist.write
  return checkedAt + (continuing ? PLAYLIST_CONTINUATION_INTERVAL : PLAYLIST_CHECK_INTERVAL)
}
