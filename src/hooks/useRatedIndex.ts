import { useCallback, useEffect, useState } from "react"
import { useProviderStore } from "../stores/providerStore"
import { useUIStore } from "../stores/uiStore"
import type { MusicAlbum, MusicTrack } from "../types/music"

const EMPTY_ITEMS: never[] = []

// Feature indexes support global ordering and album grouping without mounting offscreen artwork.
const caches = new WeakMap<
  object,
  Map<
    string,
    { session: unknown; at: number; items: unknown[]; refresh: number }
  >
>()
function useRatedCollectionIndex<T>(enabled: boolean, kind: "track" | "album") {
  const provider = useProviderStore((s) => s.provider)
  const refresh = useUIStore((s) => s.pageRefreshKey)
  const [attempt, setAttempt] = useState(0)
  const [value, setValue] = useState<{
    provider: unknown
    tracks: T[]
    ready: boolean
    error: string
    at: number
  }>({ provider: null, tracks: [], ready: false, error: "", at: 0 })
  useEffect(() => {
    const update = (event: Event) => {
      const changed = (event as CustomEvent).detail as string
      if (changed === `rated:${kind}` || changed?.startsWith("item:")) {
        if (provider) caches.get(provider)?.delete(kind)
        setAttempt((value) => value + 1)
      }
    }
    window.addEventListener("collection-cache-updated", update)
    return () => window.removeEventListener("collection-cache-updated", update)
  }, [provider, kind])
  useEffect(() => {
    if (!enabled || !provider) return
    let active = true
    const session = provider.playbackSession
    const owns = () =>
      active &&
      useProviderStore.getState().provider === provider &&
      provider.playbackSession === session
    const cached = caches.get(provider)?.get(kind)
    if (
      cached &&
      cached.session === session &&
      cached.refresh === refresh &&
      Date.now() - cached.at < 5 * 60_000
    ) {
      setValue({
        provider,
        tracks: cached.items as T[],
        ready: true,
        error: "",
        at: cached.at,
      })
      return
    }
    setValue((previous) =>
      previous.provider === provider && previous.ready
        ? { ...previous, error: "" }
        : { provider, tracks: [], ready: false, error: "", at: 0 }
    )
    void (async () => {
      const tracks: T[] = []
      if (provider.getRatedItemsPage) {
        let offset = 0
        for (;;) {
          const page = await provider.getRatedItemsPage(kind, offset, 500)
          if (!owns()) return
          if (
            page.items.length > 500 ||
            (page.offset !== undefined && page.offset !== offset)
          )
            throw Error("The server repeated a rated page.")
          for (const item of page.items)
            if (item.type === kind) {
              const { _providerData, ...track } = item
              tracks.push(track as T)
            }
          offset += page.items.length
          if (
            !page.items.length ||
            (page.total > 0 ? offset >= page.total : page.items.length < 500)
          )
            break
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      } else
        tracks.push(
          ...((kind === "track"
            ? await provider.getLikedTracks()
            : await provider.getLikedAlbums()) as T[])
        )
      if (!owns()) return
      let cache = caches.get(provider)
      if (!cache) caches.set(provider, (cache = new Map()))
      const at = Date.now()
      cache.set(kind, { session, items: tracks, at, refresh })
      setValue({ provider, tracks, ready: true, error: "", at })
    })().catch(() => {
      if (owns())
        setValue((previous) => ({
          ...previous,
          error:
            "Could not refresh this collection. Refresh the page to try again.",
        }))
    })
    return () => {
      active = false
    }
  }, [provider, enabled, kind, attempt, refresh])
  const retry = useCallback(() => {
    if (provider) caches.get(provider)?.delete(kind)
    setAttempt(value => value + 1)
  }, [provider, kind])
  return value.provider === provider
    ? { ...value, retry }
    : { tracks: EMPTY_ITEMS as T[], ready: false, error: "", at: 0, retry }
}
export const useRatedIndex = (enabled: boolean) =>
  useRatedCollectionIndex<MusicTrack>(enabled, "track")
export const useRatedAlbumIndex = (enabled: boolean) =>
  useRatedCollectionIndex<MusicAlbum>(enabled, "album")
