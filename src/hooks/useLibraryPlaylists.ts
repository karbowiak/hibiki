import { useMemo } from "react"
import { useLibraryStore } from "../stores"
import { usePlaylistOrder, sortPlaylists } from "../stores/playlistOrder"
import { useYoutubeMusicLibrary } from "../backends/ytmusic/library"
import { youtubeMusicItemHref, type YoutubeMusicItem } from "../backends/ytmusic/discovery"
import { buildExternalImageUrl } from "../lib/imageUrl"
import type { MusicPlaylist } from "../types/music"

export type LibraryPlaylist = MusicPlaylist & { youtubeMusic?: YoutubeMusicItem }
export const libraryPlaylistHref = (playlist: LibraryPlaylist) => playlist.youtubeMusic ? youtubeMusicItemHref(playlist.youtubeMusic) : `/playlist/${playlist.id}`

export function useLibraryPlaylists() {
  const plex = useLibraryStore(state => state.playlists)
  const youtube = useYoutubeMusicLibrary("playlists")
  const order = usePlaylistOrder()
  const playlists = useMemo(() => {
    const remote: LibraryPlaylist[] = youtube.connected ? youtube.items.map(item => ({
      id: `ytmusic:${item.id}`, title: item.title, smart: false, trackCount: item.trackCount ?? 0,
      duration: null, thumbUrl: buildExternalImageUrl(item.thumbnail), summary: item.description || null,
      addedAt: null, providerKey: "ytmusic", youtubeMusic: item,
    })) : []
    return sortPlaylists<LibraryPlaylist>([...plex, ...remote], order)
  }, [plex, youtube.items, youtube.connected, order])
  return { playlists, youtube }
}
