import { Button } from "../shared/Button"
import { DiscoveryCard } from "../shared/DiscoveryCard"
import { useRatedItems } from "../../hooks/useRatedItems"
import { MediaGrid } from "../shared/MediaGrid"
import { DiscoveryMore } from "../shared/DiscoveryMore"
import { useYoutubeMusicLibrary } from "../../backends/ytmusic/library"
import { interleavePages } from "../../lib/interleavedPages"
import type { DiscoveryItem } from "../../lib/discovery"

export function LikedArtists() {
  const page = useRatedItems("artist")
  const youtube = useYoutubeMusicLibrary("artists")
  const retry = () => { page.retry(); void youtube.retry() }
  const status =
    page.loading && !page.items.length
      ? "loading"
      : page.error && !page.items.length
        ? "error"
        : "ready"

  const mixed = interleavePages(page.pages, youtube.connected ? youtube.items : [],
    item => ({ source: "plex", item: { ...item, type: "artist" } } as DiscoveryItem),
    item => ({ source: "ytmusic", item } as DiscoveryItem))
  const count = mixed.total

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="collection-header">
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-3">
          <div>
            <h1 className="discovery-title">Liked Artists</h1>
            <p className="mt-2 max-w-xl select-text text-sm text-gray-400">
              {youtube.connected ? "Rated artists from Plex and artists followed in YouTube Music." : "Your rated artists."}
            </p>
          </div>
          <p className="text-sm text-gray-400">
            {count.toLocaleString()}{youtube.connected && youtube.more ? "+" : ""}{" "}
            {count === 1 ? "artist" : "artists"}
          </p>
        </div>
      </div>

      {/* Artist grid */}
      <div className="px-8 pt-2">
        {(status === "loading" || youtube.loading) && !count ? (
          <p
            role="status"
            className="px-8 py-12 text-center text-sm text-gray-400"
          >
            Loading rated artists…
          </p>
        ) : status === "error" && !count ? (
          <div
            role="alert"
            className="mx-8 my-4 rounded-lg border border-red-400/30 p-4 text-sm text-red-400"
          >
            <p>Could not load rated artists.</p>
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
            {youtube.connected ? "No saved artists yet. Rate an artist in Plex or follow one in YouTube Music." : "No rated artists yet. Rate an artist to see it here."}
          </div>
        ) : (
          <MediaGrid
            paged={mixed}
            renderItem={entry => <DiscoveryCard key={`${entry.source}:${entry.item.id}`} entry={entry} />}
          />
        )}
        {youtube.connected && <DiscoveryMore more={youtube.more} loading={youtube.loading} error={youtube.error} load={() => void (youtube.error ? youtube.retry() : youtube.loadMore())} />}
        {page.error && count > 0 && (
          <p role="alert" className="py-4 text-sm">
            {page.error}{" "}
            <Button variant="bare" className="underline" onClick={page.retry}>
              Try again
            </Button>
          </p>
        )}
      </div>
    </div>
  )
}
