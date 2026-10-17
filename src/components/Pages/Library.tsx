import { deduplicateAlbums } from "../../lib/dedup"
import { Link } from "wouter"
import {
  IconHeart,
  IconPlaylist,
  IconDisc,
  IconMicrophone,
} from "@tabler/icons-react"
import "../../styles/discovery.css"
import { useProviderStore } from "../../stores/providerStore"
import { useEffect, useMemo } from "react"
import { useLibraryStore } from "../../stores"
import { useUIStore } from "../../stores/uiStore"
import { DiscoveryCard } from "../shared/DiscoveryCard"
import { LibraryPlaylistCard } from "../shared/LibraryPlaylistCard"
import { useLibraryPlaylists } from "../../hooks/useLibraryPlaylists"
import { useYoutubeMusicLibrary } from "../../backends/ytmusic/library"
import { mergeDiscoveryItems, youtubeDiscoveryItems, type DiscoveryItem } from "../../lib/discovery"
import { ScrollRow } from "../ScrollRow"

export function Library() {
  const { playlists } = useLibraryPlaylists()
  const youtubeSongs = useYoutubeMusicLibrary("songs")
  const youtubeAlbums = useYoutubeMusicLibrary("albums")
  const youtubeArtists = useYoutubeMusicLibrary("artists")
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const rawLikedAlbums = useLibraryStore((s) => s.likedAlbums)
  const rawLikedArtists = useLibraryStore((s) => s.likedArtists)
  const fetchLikedTracks = useLibraryStore((s) => s.fetchLikedTracks)
  const fetchLikedAlbums = useLibraryStore((s) => s.fetchLikedAlbums)
  const fetchLikedArtists = useLibraryStore((s) => s.fetchLikedArtists)
  const provider = useProviderStore((s) => s.provider)
  const shouldDeduplicate=useUIStore(s=>s.deduplicateAlbums)
  const plexAlbums=useMemo(()=>shouldDeduplicate ? deduplicateAlbums(rawLikedAlbums) : rawLikedAlbums,[rawLikedAlbums,shouldDeduplicate])
  const likedAlbums = useMemo(() => mergeDiscoveryItems(plexAlbums.map(item => ({ source: "plex", item: { ...item, type: "album" } } as DiscoveryItem)),
    youtubeAlbums.connected ? youtubeDiscoveryItems(youtubeAlbums.items) : []), [plexAlbums, youtubeAlbums.connected, youtubeAlbums.items])
  const likedArtists = useMemo(() => mergeDiscoveryItems(rawLikedArtists.map(item => ({ source: "plex", item: { ...item, type: "artist" } } as DiscoveryItem)),
    youtubeArtists.connected ? youtubeDiscoveryItems(youtubeArtists.items) : []), [rawLikedArtists, youtubeArtists.connected, youtubeArtists.items])
  const pageRefreshKey = useUIStore((s) => s.pageRefreshKey)

  useEffect(() => {
    if (!provider) return
    void fetchLikedTracks()
    void fetchLikedAlbums()
    void fetchLikedArtists()
  }, [
    fetchLikedTracks,
    fetchLikedAlbums,
    fetchLikedArtists,
    pageRefreshKey,
    provider,
  ])

  const topTracks = useMemo(
    () =>
      mergeDiscoveryItems([...likedTracks]
        .sort((a, b) => (b.userRating ?? 0) - (a.userRating ?? 0))
        .map(item => ({ source: "plex", item: { ...item, type: "track" } } as DiscoveryItem)),
      youtubeSongs.connected ? youtubeDiscoveryItems(youtubeSongs.items) : []).slice(0, 25),
    [likedTracks, youtubeSongs.connected, youtubeSongs.items]
  )

  return (
    <div className="discovery-page space-y-8">
      <header className="discovery-head">
        <div>
          <h1 className="discovery-title">Your Library</h1>
          <p className="discovery-subtitle">
            Your playlists, rated favorites, and the music you keep coming back
            to.
          </p>
        </div>
        <Link href="/search" className="discovery-pill">
          Find something in your library <span aria-hidden="true">↗</span>
        </Link>
      </header>
      <nav aria-label="Library collections" className="discovery-overview">
        {[
          {
            href: "/collection/tracks",
            title: "Liked Songs",
            desc: "Your rated tracks",
            icon: IconHeart,
          },
          {
            href: "/collection/albums",
            title: "Liked Albums",
            desc: "Releases worth keeping close",
            icon: IconDisc,
          },
          {
            href: "/collection/artists",
            title: "Liked Artists",
            desc: "The artists you return to",
            icon: IconMicrophone,
          },
          {
            href: "/collection/playlists",
            title: "Playlists",
            desc: "Collections for every mood",
            icon: IconPlaylist,
          },
        ].map(({ href, title, desc, icon: Icon }) => (
          <Link key={href} href={href} className="discovery-overview-card">
            <span className="discovery-overview-icon">
              <Icon size={20} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <strong>{title}</strong>
              <small>{desc}</small>
            </span>
            <span aria-hidden="true" className="text-(--text-muted)">
              ↗
            </span>
          </Link>
        ))}
      </nav>
      {(playlists.length > 0 ||
        topTracks.length > 0 ||
        likedAlbums.length > 0 ||
        likedArtists.length > 0) && (
        <dl className="discovery-ledger" aria-label="Your library at a glance">
          {[
            ["Playlists", playlists.length],
            ["Liked songs", likedTracks.length + (youtubeSongs.connected ? youtubeSongs.items.length : 0)],
            ["Liked albums", likedAlbums.length],
            ["Liked artists", likedArtists.length],
          ]
            .filter(([, count]) => Number(count) > 0)
            .map(([label, count]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{Number(count).toLocaleString()}</dd>
              </div>
            ))}
        </dl>
      )}
      {!provider && (
        <p className="text-sm text-(--text-secondary)">
          Connect your music library in Settings to load your collections.
        </p>
      )}

      {playlists.length > 0 && (
        <ScrollRow
          title="Playlists"
          titleHref="/collection/playlists"
          restoreKey="library-playlists"
        >
          {playlists.map(playlist => <LibraryPlaylistCard key={playlist.id} playlist={playlist} scrollItem />)}
        </ScrollRow>
      )}

      {topTracks.length > 0 && (
        <ScrollRow
          title="Liked Songs"
          titleHref="/collection/tracks"
          restoreKey="library-liked-songs"
        >
          {topTracks.map(entry => <DiscoveryCard key={`${entry.source}:${entry.item.id}`} entry={entry} scrollItem />)}
        </ScrollRow>
      )}

      {likedAlbums.length > 0 && (
        <ScrollRow
          title="Liked Albums"
          titleHref="/collection/albums"
          restoreKey="library-liked-albums"
        >
          {likedAlbums.map(entry => <DiscoveryCard key={`${entry.source}:${entry.item.id}`} entry={entry} scrollItem />)}
        </ScrollRow>
      )}

      {likedArtists.length > 0 && (
        <ScrollRow
          title="Liked Artists"
          titleHref="/collection/artists"
          restoreKey="library-liked-artists"
        >
          {likedArtists.map(entry => <DiscoveryCard key={`${entry.source}:${entry.item.id}`} entry={entry} scrollItem />)}
        </ScrollRow>
      )}
    </div>
  )
}
