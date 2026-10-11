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
  const likedAlbums = useLibraryStore((s) => s.likedAlbums)
  const likedArtists = useLibraryStore((s) => s.likedArtists)
  const fetchLikedTracks = useLibraryStore((s) => s.fetchLikedTracks)
  const fetchLikedAlbums = useLibraryStore((s) => s.fetchLikedAlbums)
  const fetchLikedArtists = useLibraryStore((s) => s.fetchLikedArtists)
  const provider = useProviderStore((s) => s.provider)
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
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Your Library</h1>

      {playlists.length > 0 && (
        <ScrollRow
          title="Playlists"
          titleHref="/collection/playlists"
          restoreKey="library-playlists"
        >
          {playlists.map((pl) => (
            <MediaCard
              key={pl.id}
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
              title={track.title}
              desc={track.artistName}
              thumb={track.thumbUrl}
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
              title={album.title}
              desc={album.artistName ?? ""}
              thumb={album.thumbUrl}
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
              title={artist.title}
              desc=""
              thumb={artist.thumbUrl}
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
