import type { PlaylistCapabilities } from "./types"
/** Official https://www.last.fm/api/playlists explicitly marks this API unsupported. */
export const lastFmPlaylistCapabilities: PlaylistCapabilities = Object.freeze({
  read: false,
  createCopy: false,
  replace: false,
  reason:
    "Last.fm no longer supports its playlist API. Playlist import and export are unavailable.",
})
