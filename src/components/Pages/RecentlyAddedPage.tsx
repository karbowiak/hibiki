import { useLibraryCollection } from "../../hooks/useLikedCollection"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore, usePlayerStore } from "../../stores"
import { useProviderStore } from "../../stores/providerStore"
import { prefetchArtist, prefetchAlbum } from "../../stores/metadataCache"
import { makeOnPlay } from "../../lib/mediaPlay"
import { MediaCard } from "../MediaCard"
import { MediaGrid } from "../shared/MediaGrid"
import { getMediaInfo, makeDragPayload } from "./Home"

export function RecentlyAddedPage() {
  const recentlyAdded = useLibraryStore((s) => s.recentlyAdded)
  const { status, retry } = useLibraryCollection("recent")
  const provider = useProviderStore((s) => s.provider)
  const { playFromUri, playTrack, playPlaylist } = usePlayerStore(
    useShallow((s) => ({
      playFromUri: s.playFromUri,
      playTrack: s.playTrack,
      playPlaylist: s.playPlaylist,
    }))
  )

  function makePrefetch(info: ReturnType<typeof getMediaInfo>) {
    if (!info) return undefined
    if (info.itemType === "artist") return () => prefetchArtist(info.id)
    if (info.itemType === "album") return () => prefetchAlbum(info.id)
    return undefined
  }

  return (
    <div className="p-8">
      <h1 className="mb-6 text-3xl font-bold">Recently Added</h1>
      {recentlyAdded.length === 0 && status === "loading" ? (
        <p role="status" className="text-sm text-gray-400">
          Loading recently added items…
        </p>
      ) : recentlyAdded.length === 0 && status === "error" ? (
        <div role="alert" className="text-sm text-red-400">
          <p>Could not load recently added items.</p>
          <button
            onClick={retry}
            className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white"
          >
            Try again
          </button>
        </div>
      ) : recentlyAdded.length === 0 ? (
        <div className="text-sm text-gray-400">Nothing recently added.</div>
      ) : (
        <MediaGrid>
          {recentlyAdded.map((item, idx) => {
            const info = getMediaInfo(item)
            if (!info) return null
            return (
              <MediaCard
                key={`${item.id}-${idx}`}
                title={info.title}
                desc={info.desc}
                thumb={info.thumb}
                isArtist={info.isArtist}
                href={info.href ?? undefined}
                prefetch={makePrefetch(info)}
                onPlay={makeOnPlay(item, {
                  playTrack,
                  playFromUri,
                  playPlaylist,
                  provider,
                })}
                dragPayload={makeDragPayload(item)}
              />
            )
          })}
        </MediaGrid>
      )}
    </div>
  )
}
