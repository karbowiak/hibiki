import { MediaCard } from "../MediaCard"
import { useRatedItems } from "../../hooks/useRatedItems"
import { prefetchArtist } from "../../stores/metadataCache"
import { MediaGrid } from "../shared/MediaGrid"

export function LikedArtists() {
  const page = useRatedItems("artist")
  const retry = page.retry
  const status =
    page.loading && !page.items.length
      ? "loading"
      : page.error && !page.items.length
        ? "error"
        : "ready"

  const count = page.total

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="collection-header">
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-3">
          <div>
            <h1 className="discovery-title">Liked Artists</h1>
            <p className="mt-2 max-w-xl select-text text-sm text-gray-400">
              Artists you've rated in Plex, all in one place.
            </p>
          </div>
          <p className="text-sm text-gray-400">
            {(page.total || count).toLocaleString()}{" "}
            {(page.total || count) === 1 ? "artist" : "artists"}
          </p>
        </div>
      </div>

      {/* Artist grid */}
      <div className="px-8 pt-2">
        {status === "loading" && !count ? (
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
          <MediaGrid
            paged={page.pages}
            renderItem={(artist) => (
              <MediaCard
                key={artist.id}
                title={artist.title}
                desc=""
                href={`/artist/${artist.id}`}
                thumb={artist.thumbUrl}
                isArtist
                artistName={artist.title}
                contextItem={{ ...artist, type: "artist" }}
                userRating={artist.userRating}
                prefetch={() => prefetchArtist(artist.id)}
                dragPayload={{
                  type: "artist",
                  ids: [artist.id],
                  label: artist.title,
                }}
              />
            )}
          />
        )}
        {page.error && count > 0 && (
          <p role="alert" className="py-4 text-sm">
            {page.error}{" "}
            <button className="underline" onClick={page.retry}>
              Try again
            </button>
          </p>
        )}
      </div>
    </div>
  )
}
