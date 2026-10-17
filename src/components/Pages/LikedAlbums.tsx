import { MediaCard } from "../MediaCard"
import { useMemo } from "react"
import { useUIStore } from "../../stores/uiStore"
import { deduplicateAlbums } from "../../lib/dedup"
import { useRatedAlbumIndex } from "../../hooks/useRatedIndex"
import { useWindowedPages } from "../../hooks/useWindowedPages"
import { useRatedItems } from "../../hooks/useRatedItems"
import { prefetchAlbum } from "../../stores/metadataCache"
import { MediaGrid } from "../shared/MediaGrid"

export function LikedAlbums() {
  const page = useRatedItems("album")
  const retry = page.retry
  const status =
    page.loading && !page.items.length
      ? "loading"
      : page.error && !page.items.length
        ? "error"
        : "ready"

  const shouldDeduplicate = useUIStore((s) => s.deduplicateAlbums)
  const index = useRatedAlbumIndex(shouldDeduplicate)
  const albums = useMemo(() => deduplicateAlbums(index.tracks), [index.tracks])
  const grouped = useWindowedPages(
    shouldDeduplicate && index.ready
      ? `rated:albums:grouped:${index.at}`
      : null,
    async (offset, limit) => ({
      items: albums.slice(offset, offset + limit),
      total: albums.length,
      offset,
    }),
    albums.length
  )
  const active = shouldDeduplicate && index.ready ? grouped : page.pages
  const count = active.total

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="collection-header">
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-3">
          <div>
            <h1 className="discovery-title">Liked Albums</h1>
            <p className="mt-2 max-w-xl select-text text-sm text-gray-400">
              Albums you've rated in Plex, all in one place.
            </p>
          </div>
          <p className="text-sm text-gray-400">
            {count.toLocaleString()} {count === 1 ? "album" : "albums"}
          </p>
        </div>
      </div>

      {/* Album grid */}
      <div className="px-8 pt-2">
        {status === "loading" && !count ? (
          <p
            role="status"
            className="px-8 py-12 text-center text-sm text-gray-400"
          >
            Loading rated albums…
          </p>
        ) : status === "error" ? (
          <div
            role="alert"
            className="mx-8 my-4 rounded-lg border border-red-400/30 p-4 text-sm text-red-400"
          >
            <p>Could not load rated albums.</p>
            <button
              onClick={retry}
              className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white"
            >
              Try again
            </button>
          </div>
        ) : count === 0 ? (
          <div className="py-12 text-center text-sm text-gray-500">
            No rated albums yet. Rate an album in Plex to see it here.
          </div>
        ) : (
          <MediaGrid
            paged={active}
            renderItem={(album) => (
              <MediaCard
                key={album.id}
                title={album.title}
                desc={`${album.artistName}${album.year ? ` · ${album.year}` : ""}`}
                href={`/album/${album.id}`}
                thumb={album.thumbUrl}
                artistName={album.artistName}
                albumName={album.title}
                contextItem={{ ...album, type: "album" }}
                userRating={album.userRating}
                prefetch={() => prefetchAlbum(album.id)}
                dragPayload={{
                  type: "album",
                  ids: [album.id],
                  label: album.title,
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
