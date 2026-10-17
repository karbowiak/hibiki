import { useProviderStore } from "../stores/providerStore"
import type { MusicAlbum, MusicArtist, MusicTrack } from "../types/music"
import { useWindowedPages } from "./useWindowedPages"
import { useMemo } from "react"

export function useRatedItems<K extends "track" | "album" | "artist">(kind: K) {
  const provider = useProviderStore((state) => state.provider)
  type Item = K extends "track"
    ? MusicTrack
    : K extends "album"
      ? MusicAlbum
      : MusicArtist
  const page = useWindowedPages<Item>(
    provider ? `rated:${kind}` : null,
    async (offset, limit) => {
      if (!provider) return { items: [], total: 0 }
      if (provider.getRatedItemsPage) {
        const page = await provider.getRatedItemsPage(kind, offset, limit)
        return {
          ...page,
          items: page.items.filter(
            (item) => item.type === kind
          ) as unknown as Item[],
        }
      }
      const items = await (kind === "track"
        ? provider.getLikedTracks()
        : kind === "album"
          ? provider.getLikedAlbums()
          : provider.getLikedArtists())
      return {
        items: items.slice(offset, offset + limit) as Item[],
        total: items.length,
        offset,
      }
    }
  )
  const items = useMemo(() => page.loadedItems, [page, page.snapshot()])
  return {
    pages: page,
    items,
    total: page.total,
    loading: page.loading,
    error: page.error,
    retry: page.retry,
    complete: items.length >= page.total && !page.loading,
    loadMore: () => page.ensureRange(items.length, items.length + 200),
  }
}
