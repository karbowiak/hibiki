import { ArtworkImage, useArtworkFailures } from "../shared/ArtworkImage"
import { useEffect } from "react"
import { Link } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore, useUIStore } from "../../stores"
import { prefetchArtist } from "../../stores/metadataCache"
import { useArtistImage } from "../../hooks/useMediaImage"
import { starsFromRating } from "../../lib/formatters"
import { MediaGrid } from "../shared/MediaGrid"
import { useContextMenu } from "../../hooks/useContextMenu"


function ArtistThumb({ title, thumb }: { title: string; thumb: string | null }) {
  const { failures, onFailure } = useArtworkFailures(JSON.stringify([title, thumb]))
  const resolved = useArtistImage(title, thumb, undefined, failures)
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
        <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
      </svg>
    </div>
  )
}

export function LikedArtists() {
  const { likedArtists, fetchLikedArtists } = useLibraryStore(useShallow(s => ({ likedArtists: s.likedArtists, fetchLikedArtists: s.fetchLikedArtists })))
  const pageRefreshKey = useUIStore(s => s.pageRefreshKey)
  const { handler: ctxMenu } = useContextMenu()

  useEffect(() => {
    void fetchLikedArtists()
  }, [pageRefreshKey])

  const count = likedArtists.length

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="flex flex-row items-end p-8">
        <div className="flex w-60 h-60 flex-shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-purple-700 to-pink-500 shadow-2xl">
          <svg viewBox="0 0 24 24" width="80" height="80" fill="white">
            <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
          </svg>
        </div>

        <div className="pl-6 flex flex-col justify-between flex-1 h-60 min-w-0">
          <div>
            <div className="whitespace-nowrap text-[76px] font-black leading-none">
              Liked Artists
            </div>
            <p className="mt-2 max-w-xl select-text text-sm text-gray-400">
              Artists you've rated in Plex, all in one place.
            </p>
          </div>
          <p className="text-sm text-gray-400">
            {count} {count === 1 ? "artist" : "artists"}
          </p>
        </div>
      </div>

      {/* Artist grid */}
      <div className="px-8 pt-2">
        {count === 0 ? (
          <div className="py-12 text-center text-sm text-gray-500">
            No rated artists yet. Rate an artist in Plex to see them here.
          </div>
        ) : (
          <MediaGrid>
            {likedArtists.map(artist => {
              const stars = starsFromRating(artist.userRating)
              return (
                <Link
                  key={artist.id}
                  href={`/artist/${artist.id}`}
                  onMouseEnter={() => prefetchArtist(artist.id)}
                  onContextMenu={ctxMenu("artist", artist)}
                  className="group flex flex-col items-center gap-2 rounded-md p-3 no-underline transition-colors hover:bg-hl-card"
                >
                  <div className="relative w-full aspect-square overflow-hidden rounded-lg bg-app-surface shadow-lg">
                    <ArtistThumb title={artist.title} thumb={artist.thumbUrl} />
                  </div>
                  <div className="w-full text-center">
                    <div className="truncate font-semibold text-sm text-white group-hover:text-white">
                      {artist.title}
                    </div>
                    {stars > 0 && (
                      <div className="mt-0.5 flex items-center justify-center gap-0.5">
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
