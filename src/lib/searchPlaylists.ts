import type { MusicItem, MusicPlaylist } from "../types/music"
import type { MixedPlaylist, Owners, Service } from "../mixedPlaylists/model"

export function searchPlaylistHref(item: MusicPlaylist) {
  const mixed = (item._providerData as { mixedPlaylistId?: string } | null)?.mixedPlaylistId
  return mixed ? `/mixed-playlist/${encodeURIComponent(mixed)}` : item.id.startsWith("ytmusic:")
    ? `/ytmusic/${encodeURIComponent(item.id.slice(8))}` : `/playlist/${encodeURIComponent(item.id)}`
}

/** Only explicit aliases owned by these accounts can merge playlists. A title
 * match alone never combines independent provider playlists. */
export function linkSearchPlaylists(items: MusicItem[], linked: MixedPlaylist[], owners: Owners): MusicItem[] {
  const seen = new Set<string>()
  return items.flatMap((item): MusicItem[] => {
    if (item.type !== "playlist") return [item]
    const playlist = linked.find(playlist => playlist.aliases.includes(item.id) && Object.keys(playlist.owners).length > 0 &&
      Object.entries(playlist.owners).every(([service, owner]) => !!owner && owners[service as Service] === owner))
    if (!playlist) return [item]
    if (seen.has(playlist.id)) return []
    seen.add(playlist.id)
    return [{ ...item, id: playlist.id, title: playlist.title, providerKey: "hibiki", trackCount: playlist.items.length,
      thumbUrl: playlist.artwork ?? item.thumbUrl, _providerData: { mixedPlaylistId: playlist.id } }]
  })
}
