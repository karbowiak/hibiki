import { useEffect, useMemo, useSyncExternalStore } from "react"
import { discoveryPages } from "../lib/discoveryPages"

export type DiscoveryCursor = string | number | null
export interface DiscoverySlice<T> { items: T[]; next: DiscoveryCursor | undefined; title?: string }

/** Sequential cursor paging with one request in flight and route ownership. */
export function useDiscoveryFeed<T>(owner: unknown, key: string | null, seeds: T[], identify: (item: T) => string,
  load: ((cursor: DiscoveryCursor) => Promise<DiscoverySlice<T>>) | null,
  observe?: (receive: (cursor: DiscoveryCursor, page: DiscoverySlice<T>) => void) => () => void,
  preserveOccurrences = false) {
  const feed = useMemo(() => {
    let active = true, cursor: DiscoveryCursor | undefined = null, revision = 0
    let unobserve: (() => void) | undefined
    const listeners = new Set<() => void>()
    const pages = discoveryPages(identify, preserveOccurrences)
    const updates = new Map<DiscoveryCursor, number>()
    const state = { items: seeds, title: "", initialized: false, loading: false, error: false, more: !!load && !!key,
      nextCursor: undefined as DiscoveryCursor | undefined }
    const publish = () => { revision++; listeners.forEach(listener => listener()) }
    const apply = (at: DiscoveryCursor, page: DiscoverySlice<T>) => {
      pages.set(at, page)
      const result = pages.read()
      if (!result) return
      state.items = result.items
      state.initialized = true
      if (result.title) state.title = result.title
      cursor = result.next
      state.nextCursor = cursor
      state.more = cursor !== undefined
    }
    const next = async () => {
      if (!active || state.loading || !state.more || !load) return
      state.loading = true; state.error = false; publish()
      const previous = cursor
      const version = updates.get(previous!) ?? 0
      try {
        const page = await load(previous!)
        if (!active) return
        if ((updates.get(previous!) ?? 0) === version) apply(previous!, page)
      } catch {
        if (active) state.error = true
      } finally {
        if (active) { state.loading = false; publish() }
      }
    }
    return { state, next, snapshot: () => revision, subscribe: (listener: () => void) => {
      listeners.add(listener); return () => { listeners.delete(listener) }
    }, activate: () => {
      active = true
      if (key && load && observe) unobserve = observe((at, page) => {
        if (!active || (at !== null && !pages.has(at))) return
        updates.set(at, (updates.get(at) ?? 0) + 1)
        apply(at, page); state.error = false; publish()
      })
    }, dispose: () => { active = false; unobserve?.(); unobserve = undefined } }
    // The identity owns its initial seeds and loader; departed requests never
    // borrow the replacement route's data through mutable loader refs.
  }, [owner, key, preserveOccurrences])
  useSyncExternalStore(feed.subscribe, feed.snapshot)
  useEffect(() => { feed.activate(); void feed.next(); return feed.dispose }, [feed])
  return { ...feed.state, items: feed.state.initialized ? feed.state.items : seeds, loadMore: feed.next }
}
