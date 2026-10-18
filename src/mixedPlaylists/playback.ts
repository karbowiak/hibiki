import { usePlayerStore } from "../stores/playerStore"
import type { MusicTrack } from "../types/music"
import type { MixedPlaylist } from "./model"

export const mixedPlaylistTracks = (playlist: MixedPlaylist) => playlist.items.map(row => {
  const reference = ((!row.songs.plex?.stale ? row.songs.plex : undefined) ?? (!row.songs.ytmusic?.stale ? row.songs.ytmusic : undefined) ?? row.songs[row.original])!
  const date = reference.libraryAdded
  return { ...reference.track, ...(date ? date.provenance === "provider" ? { addedAt: new Date(date.at).toISOString() } :
    { libraryObservedAt: new Date(date.at).toISOString() } : {}), playlistItemId: row.id }
})
export function playMixedPlaylist(playlist: MixedPlaylist, startIndex = 0, tracks: MusicTrack[] = mixedPlaylistTracks(playlist)) {
  return usePlayerStore.getState().playPagedTracks({ key: `${playlist.id}:${playlist.revision}`, entries: tracks, total: tracks.length,
    loadPage: async (offset, limit) => ({ items: tracks.slice(offset, offset + limit), total: tracks.length, offset }) },
  playlist.title, `/mixed-playlist/${encodeURIComponent(playlist.id)}`, false, startIndex)
}
