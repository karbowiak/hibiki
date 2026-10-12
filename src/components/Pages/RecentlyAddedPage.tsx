import { useLocation } from "wouter"
import { PageRecovery } from "../shared/PageRecovery"
import { PageLoading } from "../shared/PageLoading"
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
  const [, navigate] = useLocation()
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
      {!provider && recentlyAdded.length === 0 ? (
        <PageRecovery
          kind="empty"
          title="Connect your library"
          description="Choose a music server in Settings to see recently added music."
          onOpenSettings={() => navigate("/settings")}
        />
      ) : recentlyAdded.length === 0 && status === "loading" ? (
        <PageLoading
          message="Loading recently added items…"
          variant="shelves"
        />
      ) : recentlyAdded.length === 0 && status === "error" ? (
        <PageRecovery
          title="Could not load recently added items."
          description="Your library may be temporarily unavailable. Try again when the connection is ready."
          onRetry={retry}
          onOpenSettings={() => navigate("/settings")}
        />
      ) : recentlyAdded.length === 0 ? (
        <PageRecovery
          kind="empty"
          title="Nothing recently added"
          description="New music in your library will appear here."
          onRetry={retry}
          onReturnLibrary={() => navigate("/library")}
        />
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
