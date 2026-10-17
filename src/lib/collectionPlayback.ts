import type { MusicProvider } from "../providers/types"
import type { CollectionOrder, PagedTrackSource } from "./pagedPlayback"
import type { MusicTrack } from "../types/music"

/** Never play a different row if a refresh moved the clicked occurrence. */
export function selectCollectionTrack(source: PagedTrackSource, track: MusicTrack, index: number): PagedTrackSource {
  return {
    ...source,
    prepare: async () => {
      const snapshot = await source.prepare?.() ?? source
      const selected = snapshot.entries?.[index]
      if (snapshot.entries && (!selected || selected.id !== track.id ||
        (track.playlistItemId != null && selected.playlistItemId !== track.playlistItemId)))
        throw Error("This collection changed. Refresh it and choose the song again.")
      return snapshot
    },
  }
}

/** The queue captures compact identities once; metadata stays lazily hydrated. */
export function collectionPlaybackSource(
  provider: MusicProvider,
  query: CollectionOrder & { key: string },
  total: number
): PagedTrackSource {
  const { key, ...order } = query
  return {
    key: `query:${key}`,
    total,
    restoreQuery: query,
    prepare: async () => {
      if (!provider.getCachedTrackSource) return null
      const snapshot = await provider.getCachedTrackSource(key, false, order)
      if (!snapshot) throw Error("This collection changed while loading. Refresh it and try again.")
      return snapshot
    },
    loadPage: async (offset, limit) => {
      const page = await provider.getCollectionPage!(key, offset, limit, order.filter, order.sort, order.dir)
      return { ...page, items: page.items.filter(item => item.type === "track") }
    },
  }
}
