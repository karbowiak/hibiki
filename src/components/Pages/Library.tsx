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
import { MediaCard } from "../MediaCard"
import type { MusicTrack } from "../../types/music"
import { ScrollRow } from "../ScrollRow"

export function Library() {
  const playlists = useLibraryStore((s) => s.playlists)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const rawLikedAlbums = useLibraryStore((s) => s.likedAlbums)
  const likedArtists = useLibraryStore((s) => s.likedArtists)
  const fetchLikedTracks = useLibraryStore((s) => s.fetchLikedTracks)
  const fetchLikedAlbums = useLibraryStore((s) => s.fetchLikedAlbums)
  const fetchLikedArtists = useLibraryStore((s) => s.fetchLikedArtists)
  const provider = useProviderStore((s) => s.provider)
  const shouldDeduplicate=useUIStore(s=>s.deduplicateAlbums)
  const likedAlbums=useMemo(()=>shouldDeduplicate ? deduplicateAlbums(rawLikedAlbums) : rawLikedAlbums,[rawLikedAlbums,shouldDeduplicate])
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
      [...likedTracks]
        .sort((a, b) => (b.userRating ?? 0) - (a.userRating ?? 0))
        .slice(0, 25),
    [likedTracks]
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
            <span aria-hidden="true" className="text-[var(--text-muted)]">
              ↗
            </span>
          </Link>
        ))}
      </nav>
      {(playlists.length > 0 ||
        likedTracks.length > 0 ||
        likedAlbums.length > 0 ||
        likedArtists.length > 0) && (
        <dl className="discovery-ledger" aria-label="Your library at a glance">
          {[
            ["Playlists", playlists.length],
            ["Liked songs", likedTracks.length],
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
        <p className="text-sm text-[var(--text-secondary)]">
          Connect your music library in Settings to load your collections.
        </p>
      )}

      {playlists.length > 0 && (
        <ScrollRow
          title="Playlists"
          titleHref="/collection/playlists"
          restoreKey="library-playlists"
        >
          {playlists.map((pl) => (
            <MediaCard
              key={pl.id}
              contextItem={{ ...pl, type: "playlist" }}
              title={pl.title}
              desc={`${pl.trackCount} songs`}
              thumb={pl.thumbUrl}
              href={`/playlist/${pl.id}`}
              scrollItem
            />
          ))}
        </ScrollRow>
      )}

      {topTracks.length > 0 && (
        <ScrollRow
          title="Liked Songs"
          titleHref="/collection/tracks"
          restoreKey="library-liked-songs"
        >
          {topTracks.map((track) => (
            <MediaCard
              key={track.id}
              contextItem={{ ...track, type: "track" }}
              title={track.title}
              desc={track.artistName}
              thumb={track.thumbUrl}
              artistName={track.artistName}
              albumName={track.albumName}
              href={track.albumId ? `/album/${track.albumId}` : undefined}
              dragPayload={{
                type: "track",
                ids: [track.id],
                label: track.title,
                tracks: [track as MusicTrack],
              }}
              scrollItem
            />
          ))}
        </ScrollRow>
      )}

      {likedAlbums.length > 0 && (
        <ScrollRow
          title="Liked Albums"
          titleHref="/collection/albums"
          restoreKey="library-liked-albums"
        >
          {likedAlbums.map((album) => (
            <MediaCard
              key={album.id}
              contextItem={{ ...album, type: "album" }}
              title={album.title}
              desc={album.artistName ?? ""}
              thumb={album.thumbUrl}
              artistName={album.artistName}
              albumName={album.title}
              href={`/album/${album.id}`}
              dragPayload={{
                type: "album",
                ids: [album.id],
                label: album.title,
              }}
              scrollItem
            />
          ))}
        </ScrollRow>
      )}

      {likedArtists.length > 0 && (
        <ScrollRow
          title="Liked Artists"
          titleHref="/collection/artists"
          restoreKey="library-liked-artists"
        >
          {likedArtists.map((artist) => (
            <MediaCard
              key={artist.id}
              contextItem={{ ...artist, type: "artist" }}
              title={artist.title}
              desc=""
              thumb={artist.thumbUrl}
              artistName={artist.title}
              isArtist
              href={`/artist/${artist.id}`}
              dragPayload={{
                type: "artist",
                ids: [artist.id],
                label: artist.title,
              }}
              scrollItem
            />
          ))}
        </ScrollRow>
      )}
    </div>
  )
}
