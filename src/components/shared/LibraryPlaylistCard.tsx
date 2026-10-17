import { MediaCard } from "../MediaCard"
import { DiscoveryCard } from "./DiscoveryCard"
import { libraryPlaylistHref, type LibraryPlaylist } from "../../hooks/useLibraryPlaylists"
import { usePlayerStore } from "../../stores/playerStore"

export function LibraryPlaylistCard({ playlist, scrollItem }: { playlist: LibraryPlaylist; scrollItem?: boolean }) {
  if (playlist.youtubeMusic) return <DiscoveryCard entry={{ source: "ytmusic", item: playlist.youtubeMusic }} scrollItem={scrollItem} />
  const href = libraryPlaylistHref(playlist)
  return <MediaCard contextItem={{ ...playlist, type: "playlist" }} href={href} title={playlist.title}
    desc={`${playlist.trackCount.toLocaleString()} ${playlist.trackCount === 1 ? "song" : "songs"}`} thumb={playlist.thumbUrl} scrollItem={scrollItem}
    onPlay={() => void usePlayerStore.getState().playPlaylist(playlist.id, playlist.trackCount, playlist.title, href)} />
}
