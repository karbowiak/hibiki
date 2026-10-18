import { MediaCard } from "../MediaCard"
import { DiscoveryCard } from "./DiscoveryCard"
import { libraryPlaylistHref, type LibraryPlaylist } from "../../hooks/useLibraryPlaylists"
import { usePlayerStore } from "../../stores/playerStore"
import { playMixedPlaylist } from "../../mixedPlaylists/playback"
import { playlistSourceLabel } from "../../mixedPlaylists/model"
import { MusicSourceBadge } from "./MusicSource"
import { IconDeviceDesktop } from "@tabler/icons-react"

export function PlaylistSourceBadge({ playlist }: { playlist: LibraryPlaylist }) {
  const sources = playlist.mixed
    ? (["plex", "ytmusic"] as const).filter(source => !!playlist.mixed!.providers[source])
    : [playlist.youtubeMusic ? "ytmusic" as const : "plex" as const]
  return <span className="inline-flex items-center gap-1.5">
    {sources.length ? sources.map(source => <MusicSourceBadge key={source} source={source} />)
      : <span title="Hibiki · saved on this device" className="inline-flex text-white"><IconDeviceDesktop size={14} aria-hidden="true" /><span className="sr-only">Hibiki · saved on this device</span></span>}
  </span>
}

export function LibraryPlaylistCard({ playlist, scrollItem }: { playlist: LibraryPlaylist; scrollItem?: boolean }) {
  if (playlist.mixed) return <MediaCard href={libraryPlaylistHref(playlist)} title={playlist.title} desc={`${playlist.trackCount.toLocaleString()} songs · ${playlistSourceLabel(playlist.mixed)}`}
    artworkBadge={<PlaylistSourceBadge playlist={playlist} />} thumb={playlist.thumbUrl} scrollItem={scrollItem} onPlay={() => void playMixedPlaylist(playlist.mixed!)} />
  if (playlist.youtubeMusic) return <DiscoveryCard entry={{ source: "ytmusic", item: playlist.youtubeMusic }} scrollItem={scrollItem} />
  const href = libraryPlaylistHref(playlist)
  return <MediaCard contextItem={{ ...playlist, type: "playlist" }} href={href} title={playlist.title}
    artworkBadge={<PlaylistSourceBadge playlist={playlist} />} desc={`${playlist.trackCount.toLocaleString()} ${playlist.trackCount === 1 ? "song" : "songs"}`} thumb={playlist.thumbUrl} scrollItem={scrollItem}
    onPlay={() => void usePlayerStore.getState().playPlaylist(playlist.id, playlist.trackCount, playlist.title, href)} />
}
