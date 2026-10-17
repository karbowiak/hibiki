import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useFavoritesStore } from "../stores/favoritesStore"
import { useProviderStore } from "../stores/providerStore"
import { useProviderOwner } from "./useProviderOwner"
import { collectionIndexItem } from "../lib/collectionIndexItem"
import { CollectionIndex } from "../lib/collectionIndex"
import type { MusicProvider } from "../providers/types"
import type { MusicTrack } from "../types/music"

const caches = new WeakMap<
  MusicProvider,
  {
    entries: unknown
    scope: unknown
    session: unknown
    resource: CollectionIndex<MusicTrack>
  }
>()
if (typeof window !== "undefined")
  window.addEventListener("collection-cache-updated", (event) => {
    const key = (event as CustomEvent<string>).detail
    const provider = useProviderStore.getState().provider
    if (provider && (key === "*" || key?.startsWith("item:")))
      caches.get(provider)?.resource.retry()
  })
/** Metadata-dependent ordering shares one owned native read, with explicit retry. */
export function useFavoriteIndex(enabled: boolean) {
  const { provider, scope, session } = useProviderOwner()
  const entries = useFavoritesStore((state) => state.collection.entries)
  const resource = useMemo(() => {
    const owns = () =>
      enabled &&
      !!provider &&
      provider === useProviderStore.getState().provider &&
      provider.cacheScope === scope &&
      provider.playbackSession === session
    const load = async () => {
      const ids = [
        ...new Set(
          Object.values(entries)
            .filter((entry) => entry.liked || entry.rating?.value != null)
            .flatMap((entry) => entry.localTrackIds)
        ),
      ]
      const tracks: MusicTrack[] = []
      if (ids.length && !provider?.favorites?.cachedTracks)
        throw Error("Favorite metadata is unavailable")
      for (let offset = 0; offset < ids.length; offset += 200) {
        const rows = await provider!.favorites!.cachedTracks!(
          ids.slice(offset, offset + 200)
        )
        if (!owns()) throw Error("Library changed")
        tracks.push(
          ...rows.map(
            (row) =>
              collectionIndexItem({ ...row, type: "track" }) as MusicTrack
          )
        )
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      return tracks
    }
    const cached = provider && enabled ? caches.get(provider) : undefined
    if (
      cached && cached.entries === entries &&
      cached.scope === scope &&
      cached.session === session
    )
      return cached.resource
    const resource = new CollectionIndex(load, owns)
    if (provider && enabled)
      caches.set(provider, { entries, scope, session, resource })
    return resource
  }, [provider, scope, session, entries, enabled])
  const value = useSyncExternalStore(resource.subscribe, resource.snapshot)
  useEffect(() => {
    if (enabled) resource.read()
  }, [resource, enabled])
  return {
    tracks: value.items,
    ready: value.ready,
    error: value.error,
    retry: resource.retry,
  }
}
