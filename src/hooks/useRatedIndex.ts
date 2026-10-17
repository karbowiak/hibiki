import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useProviderStore } from "../stores/providerStore"
import { useUIStore } from "../stores/uiStore"
import { useProviderOwner } from "./useProviderOwner"
import { collectionIndexItem } from "../lib/collectionIndexItem"
import { CollectionIndex } from "../lib/collectionIndex"
import type { MusicAlbum, MusicTrack } from "../types/music"
import type { MusicProvider } from "../providers/types"

const caches = new WeakMap<
  MusicProvider,
  Map<
    string,
    {
      session: unknown
      scope: unknown
      refresh: number
      resource: CollectionIndex<unknown>
    }
  >
>()
// Inactive indexes must also expire when background refreshes finish.
if (typeof window !== "undefined")
  window.addEventListener("collection-cache-updated", (event) => {
    const provider = useProviderStore.getState().provider
    const key = (event as CustomEvent<string>).detail
    if (!provider) return
    for (const [kind, cached] of caches.get(provider) ?? [])
      if (key === "*" || key === `rated:${kind}` || key?.startsWith("item:"))
        cached.resource.retry()
  })
function useRatedCollectionIndex<T>(enabled: boolean, kind: "track" | "album") {
  const { provider, scope, session } = useProviderOwner()
  const refresh = useUIStore((state) => state.pageRefreshKey)
  const resource = useMemo(() => {
    const owns = () =>
      enabled &&
      !!provider &&
      provider === useProviderStore.getState().provider &&
      provider.cacheScope === scope &&
      provider.playbackSession === session
    const load = async () => {
      const items: T[] = []
      if (!provider) return items
      if (provider.getRatedItemsPage) {
        let offset = 0
        let generation: unknown
        for (;;) {
          const page = await (
            provider.getRatedIndexPage ?? provider.getRatedItemsPage
          ).call(provider, kind, offset, 500)
          if (!owns()) throw Error("Library changed")
          if (offset === 0) generation = page.generation
          else if (generation !== page.generation) throw Error("Collection changed while indexing")
          if (
            page.items.length > 500 ||
            (page.offset !== undefined && page.offset !== offset) ||
            offset + page.items.length > 1_000_000
          )
            throw Error("Invalid rated collection page")
          for (const item of page.items)
            if (item.type === kind) {
              items.push(collectionIndexItem(item) as T)
            }
          offset += page.items.length
          if (
            !page.items.length ||
            (page.total > 0 ? offset >= page.total : page.items.length < 500)
          )
            break
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      } else {
        const rows = kind === "track" ? await provider.getLikedTracks() : await provider.getLikedAlbums()
        items.push(...rows.map(row => collectionIndexItem({ ...row, type: kind } as any) as T))
      }
      return items
    }
    if (!provider || !enabled) return new CollectionIndex<T>(load, owns)
    let cache = caches.get(provider)
    if (!cache) caches.set(provider, (cache = new Map()))
    const cached = cache.get(kind)
    if (
      cached && cached.scope === scope &&
      cached.session === session &&
      cached.refresh === refresh
    )
      return cached.resource as CollectionIndex<T>
    const resource = new CollectionIndex<T>(load, owns)
    cache.set(kind, {
      session,
      scope,
      refresh,
      resource: resource as CollectionIndex<unknown>,
    })
    return resource
  }, [provider, scope, session, refresh, enabled, kind])
  const value = useSyncExternalStore(resource.subscribe, resource.snapshot)
  useEffect(() => {
    if (enabled) resource.read()
  }, [resource, enabled])
  return {
    tracks: value.items,
    ready: value.ready,
    error: value.error,
    at: value.at,
    retry: resource.retry,
  }
}
export const useRatedIndex = (enabled: boolean) =>
  useRatedCollectionIndex<MusicTrack>(enabled, "track")
export const useRatedAlbumIndex = (enabled: boolean) =>
  useRatedCollectionIndex<MusicAlbum>(enabled, "album")
