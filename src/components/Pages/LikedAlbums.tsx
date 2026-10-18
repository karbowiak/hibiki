import { Button } from "../shared/Button"
import { DiscoveryCard } from "../shared/DiscoveryCard"
import { useProviderStore } from "../../stores/providerStore"
import { useMemo } from "react"
import { useUIStore } from "../../stores/uiStore"
import { deduplicateAlbums } from "../../lib/dedup"
import { useRatedAlbumIndex } from "../../hooks/useRatedIndex"
import { useWindowedPages } from "../../hooks/useWindowedPages"
import { useRatedItems } from "../../hooks/useRatedItems"
import { MediaGrid } from "../shared/MediaGrid"
import { DiscoveryMore } from "../shared/DiscoveryMore"
import { useYoutubeMusicLibrary } from "../../backends/ytmusic/library"
import { interleavePages } from "../../lib/interleavedPages"
import type { DiscoveryItem } from "../../lib/discovery"

export function LikedAlbums() {
  const provider = useProviderStore(state => state.provider)
  const shouldDeduplicate = useUIStore((s) => s.deduplicateAlbums)
  const index = useRatedAlbumIndex(shouldDeduplicate)
  const page = useRatedItems("album", !shouldDeduplicate)
  const youtube = useYoutubeMusicLibrary("albums")
  const plexError = shouldDeduplicate ? index.error : page.error
  const plexLoading = shouldDeduplicate ? !index.ready && !index.error : page.loading && !page.items.length
  const retryPlex = shouldDeduplicate ? index.retry : page.retry
  const retry = () => { retryPlex(); void youtube.retry() }
  const status = plexLoading ? "loading" : plexError ? "error" : "ready"

  const albums = useMemo(() => deduplicateAlbums(index.tracks), [index.tracks])
  const grouped = useWindowedPages(
    shouldDeduplicate && index.ready
      ? `rated:albums:grouped:${index.at}`
      : null,
    async (offset, limit) => {
      const selected = albums.slice(offset, offset + limit)
      const details = provider?.getCollectionItems
        ? await provider.getCollectionItems("rated:album", selected.map(album => album.id))
        : await Promise.all(selected.map(album => provider.getAlbum(album.id)))
      return { items: selected.map((album, index) => ({ ...details[index], _alternateIds: album._alternateIds }) as typeof album), total: albums.length, offset }
    },
    albums.length
  )
  const active = shouldDeduplicate ? grouped : page.pages
  const mixed = interleavePages(active, youtube.connected ? youtube.items : [],
    item => ({ source: "plex", item: { ...item, type: "album" } } as DiscoveryItem),
    item => ({ source: "ytmusic", item } as DiscoveryItem))
  const count = mixed.total

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="collection-header">
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-3">
          <div>
            <h1 className="discovery-title">Liked Albums</h1>
            <p className="mt-2 max-w-xl select-text text-sm text-gray-400">
              {youtube.connected ? "Rated albums from Plex and albums saved in YouTube Music." : "Your rated albums."}
            </p>
          </div>
          <p className="text-sm text-gray-400">
            {count.toLocaleString()}{youtube.connected && youtube.more ? "+" : ""} {count === 1 ? "album" : "albums"}
          </p>
        </div>
      </div>

      {/* Album grid */}
      <div className="px-8 pt-2">
        {(status === "loading" || youtube.loading) && !count ? (
          <p
            role="status"
            className="px-8 py-12 text-center text-sm text-gray-400"
          >
            Loading rated albums…
          </p>
        ) : status === "error" && !count ? (
          <div
            role="alert"
            className="mx-8 my-4 rounded-lg border border-red-400/30 p-4 text-sm text-red-400"
          >
            <p>Could not load rated albums.</p>
            <Button
              variant="bare"
              onClick={retry}
              className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white"
            >
              Try again
            </Button>
          </div>
        ) : count === 0 ? (
          <div className="py-12 text-center text-sm text-gray-500">
            {youtube.connected ? "No saved albums yet. Rate an album in Plex or save one in YouTube Music." : "No rated albums yet. Rate an album to see it here."}
          </div>
        ) : (
          <MediaGrid
            paged={mixed}
            renderItem={entry => <DiscoveryCard key={`${entry.source}:${entry.item.id}`} entry={entry} showYear />}
          />
        )}
        {youtube.connected && <DiscoveryMore more={youtube.more} loading={youtube.loading} error={youtube.error} load={() => void (youtube.error ? youtube.retry() : youtube.loadMore())} />}
        {plexError && count > 0 && (
          <p role="alert" className="py-4 text-sm">
            {plexError}{" "}
            <Button variant="bare" className="underline" onClick={retryPlex}>
              Try again
            </Button>
          </p>
        )}
      </div>
    </div>
  )
}
