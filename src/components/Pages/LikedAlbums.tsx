import { ArtworkImage, useArtworkFailures } from "../shared/ArtworkImage"
import { useEffect } from "react"
import { Link } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore, useUIStore } from "../../stores"
import { prefetchAlbum } from "../../stores/metadataCache"
import { useAlbumImage } from "../../hooks/useMediaImage"
import { starsFromRating } from "../../lib/formatters"
import { MediaGrid } from "../shared/MediaGrid"
import { useContextMenu } from "../../hooks/useContextMenu"


function AlbumThumb({ artist, title, thumb }: { artist: string; title: string; thumb: string | null }) {
  const { failures, onFailure } = useArtworkFailures(JSON.stringify([artist, title, thumb]))
  const resolved = useAlbumImage(artist, title, thumb, undefined, failures)
  if (resolved) {
    return (
      <ArtworkImage
        onFailure={onFailure}
        src={resolved}
        alt={title}
        loading="lazy"
        className="h-full w-full object-cover transition-transform group-hover:scale-105"
      />
    )
  }
  return (
    <div className="flex h-full w-full items-center justify-center">
      <svg viewBox="0 0 24 24" width="40" height="40" fill="#535353">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
      </svg>
    </div>
  )
}

export function LikedAlbums() {
  const { likedAlbums, fetchLikedAlbums } = useLibraryStore(useShallow(s => ({ likedAlbums: s.likedAlbums, fetchLikedAlbums: s.fetchLikedAlbums })))
  const pageRefreshKey = useUIStore(s => s.pageRefreshKey)
  const { handler: ctxMenu } = useContextMenu()

  useEffect(() => {
    void fetchLikedAlbums()
  }, [pageRefreshKey])

  const count = likedAlbums.length

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="flex flex-row items-end p-8">
        <div className="flex w-60 h-60 flex-shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-green-700 to-teal-500 shadow-2xl">
          <svg viewBox="0 0 24 24" width="80" height="80" fill="white">
            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
          </svg>
        </div>

        <div className="pl-6 flex flex-col justify-between flex-1 h-60 min-w-0">
          <div>
            <div className="whitespace-nowrap text-[76px] font-black leading-none">
              Liked Albums
            </div>
            <p className="mt-2 max-w-xl select-text text-sm text-gray-400">
              Albums you've rated in Plex, all in one place.
            </p>
          </div>
          <p className="text-sm text-gray-400">
            {count} {count === 1 ? "album" : "albums"}
          </p>
        </div>
      </div>

      {/* Album grid */}
      <div className="px-8 pt-2">
        {count === 0 ? (
          <div className="py-12 text-center text-sm text-gray-500">
            No rated albums yet. Rate an album in Plex to see it here.
          </div>
        ) : (
          <MediaGrid>
            {likedAlbums.map(album => {
              const stars = starsFromRating(album.userRating)
              return (
                <Link
                  key={album.id}
                  href={`/album/${album.id}`}
                  onMouseEnter={() => prefetchAlbum(album.id)}
                  onContextMenu={ctxMenu("album", album)}
                  className="group flex flex-col gap-2 rounded-md p-3 no-underline transition-colors hover:bg-hl-card"
                >
                  <div className="relative w-full aspect-square overflow-hidden rounded-md bg-app-surface shadow-lg">
                    <AlbumThumb artist={album.artistName} title={album.title} thumb={album.thumbUrl} />
                  </div>
                  <div className="w-full min-w-0">
                    <div className="truncate font-semibold text-sm text-white">
                      {album.title}
                    </div>
                    <div className="truncate text-xs text-gray-400">
                      {album.artistName}
                      {album.year ? ` · ${album.year}` : ""}
                    </div>
                    {stars > 0 && (
                      <div className="mt-0.5 flex items-center gap-0.5">
                        {Array.from({ length: 5 }, (_, i) => (
                          <svg
                            key={i}
                            viewBox="0 0 16 16"
                            width="10"
                            height="10"
                            fill={i < stars ? "var(--accent)" : "#535353"}
                          >
                            <path d="M8 .5l1.8 3.7 4.1.6-3 2.9.7 4.1L8 9.8l-3.7 1.9.7-4.1-3-2.9 4.1-.6z" />
                          </svg>
                        ))}
                      </div>
                    )}
                  </div>
                </Link>
              )
            })}
          </MediaGrid>
        )}
      </div>
    </div>
  )
}
