import { useLikedCollection } from "../../hooks/useLikedCollection"
import { ArtworkImage, useArtworkFailures } from "../shared/ArtworkImage"
import { Link } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore } from "../../stores"
import { prefetchArtist } from "../../stores/metadataCache"
import { useArtistImage } from "../../hooks/useMediaImage"
import { starsFromRating } from "../../lib/formatters"
import { MediaGrid } from "../shared/MediaGrid"
import { useContextMenu } from "../../hooks/useContextMenu"

function ArtistThumb({
  title,
  thumb,
}: {
  title: string
  thumb: string | null
}) {
  const { failures, onFailure } = useArtworkFailures(
    JSON.stringify([title, thumb])
  )
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
  const { likedArtists } = useLibraryStore(
    useShallow((s) => ({ likedArtists: s.likedArtists }))
  )
  const { status, retry } = useLikedCollection("artists")
  const { handler: ctxMenu } = useContextMenu()

  const count = likedArtists.length

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-5 px-8 py-6">
        <div className="flex h-32 w-32 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-purple-700 to-pink-500 shadow-lg">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="56" height="56" fill="white">
            <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
          </svg>
        </div>

        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-3">
          <div>
            <h1 className="break-words text-[clamp(1.75rem,3.2vw,3rem)] font-bold leading-tight tracking-tight">
              Liked Artists
            </h1>
            <p className="mt-2 max-w-xl select-text text-sm text-gray-400">
              Artists you've rated in Plex, all in one place.
            </p>
          </div>
          <p className="text-sm text-gray-400">
            {count.toLocaleString()} {count === 1 ? "artist" : "artists"}
          </p>
        </div>
      </div>

      {/* Artist grid */}
      <div className="px-8 pt-2">
        {status === "loading" ? (
          <p
            role="status"
            className="px-8 py-12 text-center text-sm text-gray-400"
          >
            Loading rated artists…
          </p>
        ) : status === "error" ? (
          <div
            role="alert"
            className="mx-8 my-4 rounded-lg border border-red-400/30 p-4 text-sm text-red-400"
          >
            <p>Could not load rated artists.</p>
            <button
              onClick={retry}
              className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white"
            >
              Try again
            </button>
          </div>
        ) : count === 0 ? (
          <div className="py-12 text-center text-sm text-gray-500">
            No rated artists yet. Rate an artist in Plex to see them here.
          </div>
        ) : (
          <MediaGrid>
            {likedArtists.map((artist) => {
              const stars = starsFromRating(artist.userRating)
              return (
                <Link
                  key={artist.id}
                  href={`/artist/${artist.id}`}
                  onMouseEnter={() => prefetchArtist(artist.id)}
                  onContextMenu={ctxMenu("artist", artist)}
                  className="group flex flex-col items-center gap-2 rounded-md p-3 no-underline transition-colors hover:bg-hl-card"
                >
                  <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-app-surface shadow-lg">
                    <ArtistThumb title={artist.title} thumb={artist.thumbUrl} />
                  </div>
                  <div className="w-full text-center">
                    <div className="truncate text-sm font-semibold text-white group-hover:text-white">
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
