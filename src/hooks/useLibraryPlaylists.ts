import { useMemo } from "react"
import { useLibraryStore } from "../stores"
import { usePlaylistOrder, sortPlaylists } from "../stores/playlistOrder"
import { useYoutubeMusicLibrary } from "../backends/ytmusic/library"
import { youtubeMusicItemHref, type YoutubeMusicItem } from "../backends/ytmusic/discovery"
import { buildExternalImageUrl } from "../lib/imageUrl"
import type { MusicPlaylist } from "../types/music"
import { useMixedPlaylistStore } from "../stores/mixedPlaylistStore"
import { useProviderStore } from "../stores/providerStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import type { MixedPlaylist } from "../mixedPlaylists/model"

export type LibraryPlaylist = MusicPlaylist & { youtubeMusic?: YoutubeMusicItem; mixed?: MixedPlaylist }
export const libraryPlaylistHref = (playlist: LibraryPlaylist) => playlist.mixed ? `/mixed-playlist/${encodeURIComponent(playlist.mixed.id)}` : playlist.youtubeMusic ? youtubeMusicItemHref(playlist.youtubeMusic) : `/playlist/${playlist.id}`

export function useLibraryPlaylists() {
  const plex = useLibraryStore(state => state.playlists)
  const youtube = useYoutubeMusicLibrary("playlists")
  const order = usePlaylistOrder()
  const mixed = useMixedPlaylistStore(state => state.playlists)
  const scope = useProviderStore(state => state.provider?.cacheScope)
  const account = useYoutubeMusicDiscoveryStore(state => state.connected ? state.accountId : null)
  const playlists = useMemo(() => {
    const remote: LibraryPlaylist[] = youtube.connected ? youtube.items.map(item => ({
      id: `ytmusic:${item.id}`, title: item.title, smart: false, trackCount: item.trackCount ?? 0,
      duration: null, thumbUrl: buildExternalImageUrl(item.thumbnail), summary: item.description || null,
      addedAt: null, providerKey: "ytmusic", youtubeMusic: item,
    })) : []
    const linked = mixed.filter(item => item.local || item.owners.plex === scope && item.owners.ytmusic === account)
    const seen = new Set<string>()
    const combined: LibraryPlaylist[] = []
    for (const playlist of [...plex, ...remote]) {
      const link = linked.find(item => item.aliases.includes(playlist.id))
      if (!link) { combined.push(playlist); continue }
      // App-owned lists keep their own slot before/after materialization. Their
      // appearance must not inherit a new counterpart's provider sort position.
      if (link.local) continue
      if (seen.has(link.id)) continue
      seen.add(link.id)
      const alias = link.local ? link.id : link.aliases[0]
      combined.push({ ...playlist, id: alias, title: link.title, trackCount: link.items.length, mixed: link, youtubeMusic: undefined })
    }
    for (const link of [...linked].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) if (!seen.has(link.id)) combined.push({
      id: link.local ? link.id : link.aliases[0] ?? link.id, title: link.title, smart: false, trackCount: link.items.length,
      duration: null, thumbUrl: link.artwork ?? link.items[0]?.songs[link.items[0]?.original]?.track.thumbUrl ?? null,
      summary: link.description ?? null, addedAt: new Date(link.createdAt).toISOString(), providerKey: "hibiki", mixed: link,
    })
    for (const item of combined) if (item.mixed?.local) {
      item.thumbUrl = item.mixed.artwork ?? item.thumbUrl
      item.summary = item.mixed.description ?? null
    }
    return sortPlaylists<LibraryPlaylist>(combined, order)
  }, [plex, youtube.items, youtube.connected, order, mixed, scope, account])
  return { playlists, youtube }
}
