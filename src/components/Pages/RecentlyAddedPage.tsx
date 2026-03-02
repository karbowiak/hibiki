import { useShallow } from "zustand/react/shallow"
import { useLibraryStore, useConnectionStore, usePlayerStore, buildPlexImageUrl } from "../../stores"
import { prefetchArtist, prefetchAlbum } from "../../stores/metadataCache"
import { buildItemUri } from "../../lib/plex"
import { MediaCard } from "../MediaCard"
import { getMediaInfo } from "./Home"

export function RecentlyAddedPage() {
  const recentlyAdded = useLibraryStore(s => s.recentlyAdded)
  const { baseUrl, token, musicSectionId, sectionUuid } = useConnectionStore()
  const { playFromUri, playTrack, playPlaylist } = usePlayerStore(useShallow(s => ({
    playFromUri:  s.playFromUri,
    playTrack:    s.playTrack,
    playPlaylist: s.playPlaylist,
  })))

  const sectionId = musicSectionId ?? 0

  function makePrefetch(info: ReturnType<typeof getMediaInfo>) {
    if (!info) return undefined
    if (info.itemType === "artist") return () => prefetchArtist(info.ratingKey, sectionId)
    if (info.itemType === "album") return () => prefetchAlbum(info.ratingKey)
    return undefined
  }

  function makeOnPlay(item: typeof recentlyAdded[number]) {
    if (item.type === "track") {
      return () => void playTrack(item, [item], item.grandparent_title, null)
    }
    if (!sectionUuid) return undefined
    if (item.type === "album") {
      const uri = buildItemUri(sectionUuid, `/library/metadata/${item.rating_key}`)
      return () => void playFromUri(uri, false, item.title, `/album/${item.rating_key}`)
    }
    if (item.type === "artist") {
      const uri = buildItemUri(sectionUuid, `/library/metadata/${item.rating_key}`)
      return () => void playFromUri(uri, false, item.title, `/artist/${item.rating_key}`)
    }
    if (item.type === "playlist") {
      return () => void playPlaylist(item.rating_key, item.leaf_count, item.title, `/playlist/${item.rating_key}`)
    }
    return undefined
  }

  return (
    <div className="p-8">
      <h1 className="mb-6 text-3xl font-bold">Recently Added</h1>
      {recentlyAdded.length === 0 ? (
        <div className="text-sm text-gray-400">Nothing recently added.</div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(var(--card-size, 160px), 1fr))" }}>
          {recentlyAdded.map((item, idx) => {
            const info = getMediaInfo(item, baseUrl, token)
            if (!info) return null
            return (
              <MediaCard
                key={idx}
                title={info.title}
                desc={info.desc}
                thumb={info.thumb}
                isArtist={info.isArtist}
                href={info.href ?? undefined}
                prefetch={makePrefetch(info)}
                onPlay={makeOnPlay(item)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
