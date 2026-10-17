import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react"
import type { PagedResult } from "../types/music"
import { WindowedPages } from "../lib/windowedPages"
import { useProviderStore } from "../stores/providerStore"
import { useUIStore } from "../stores/uiStore"
import type { MusicProvider } from "../providers/types"

function ownedLoader<T>(
  provider: MusicProvider,
  source: (offset: number, limit: number) => Promise<PagedResult<T>>
) {
  const session = provider.playbackSession
  return async (offset: number, limit: number) => {
    const owns = () =>
      useProviderStore.getState().provider === provider &&
      session === provider.playbackSession
    if (!owns()) throw Error("Library changed")
    const result = await source(offset, limit)
    if (!owns()) throw Error("Library changed")
    return result
  }
}

const caches = new WeakMap<
  object,
  Map<
    string,
    {
      value: WindowedPages<unknown>
      at: number
      session: unknown
      refresh: number
    }
  >
>()
useProviderStore.subscribe((state, previous) => {
  if (previous.provider && previous.provider !== state.provider)
    caches.delete(previous.provider)
})
export function useWindowedPages<T>(
  key: string | null,
  load: (offset: number, limit: number) => Promise<PagedResult<T>>,
  total = 0,
  version?: unknown
) {
  const provider = useProviderStore((s) => s.provider)
  const refresh = useUIStore((s) => s.pageRefreshKey)
  const loader = useRef(load)
  loader.current = load
  const pages = useMemo(() => {
    if (!provider || !key)
      return new WindowedPages<T>(async () => ({ items: [], total: 0 }))
    let cache = caches.get(provider)
    if (!cache) caches.set(provider, (cache = new Map()))
    const existing = cache.get(key)
    if (
      existing &&
      Date.now() - existing.at < 5 * 60_000 &&
      existing.session === provider.playbackSession &&
      existing.refresh === refresh
    ) {
      cache.delete(key)
      cache.set(key, existing)
      return existing.value as WindowedPages<T>
    }
    const session = provider.playbackSession
    // Capture the source belonging to this key; a departed route cannot reuse its replacement's loader.
    const source = loader.current
    const value = new WindowedPages<T>(ownedLoader(provider, source), total)
    cache.set(key, { value, at: Date.now(), session, refresh })
    while (cache.size > 8) cache.delete(cache.keys().next().value!)
    return value
  }, [provider, key, refresh])
  useSyncExternalStore(pages.subscribe, pages.snapshot)
  useLayoutEffect(() => {
    if (provider && key && version !== undefined)
      pages.updateSource(ownedLoader(provider, loader.current), total, version)
  }, [provider, key, pages, version, total])
  useLayoutEffect(() => {
    if (key) pages.ensureRange(0, 1)
  }, [key, pages])
  useEffect(() => {
    const update = (event: Event) => {
      const changed = (event as CustomEvent).detail as string
      // Discard inactive renderer snapshots too; returning to a page must not
      // resurrect a pre-edit collection. Active views retain their visible rows.
      if (provider) caches.get(provider)?.clear()
      let matches = changed === key || changed?.startsWith("item:")
      if (key?.startsWith("[")) {
        const [kind, id] = JSON.parse(key) as string[]
        matches ||= kind === "playlist-query" && changed === `playlist:${id}`
        matches ||= kind === "mix-query" && changed === `mix:${id}`
        matches ||= kind === "liked" && changed === "rated:track"
      }
      if (matches) pages.invalidate()
    }
    window.addEventListener("collection-cache-updated", update)
    return () => window.removeEventListener("collection-cache-updated", update)
  }, [key, pages, provider])
  return pages
}
