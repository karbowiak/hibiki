import { create } from "zustand"
import { recordRecentSearch } from "../lib/recentSearches"
import type { MusicItem } from "../types/music"
import type { MusicProvider } from "../providers/types"
import { useProviderStore } from "./providerStore"

interface SearchState {
  query: string
  results: MusicItem[]
  isSearching: boolean
  error: string | null
  setQuery: (q: string) => void
  search: (q: string) => Promise<void>
  clear: () => void
  acceptLocalRefresh: (
    scope: string,
    session: unknown,
    query: string,
    results: MusicItem[]
  ) => void
}

export function createSearchStore(
  getProvider: () => MusicProvider | null = () =>
    useProviderStore.getState().provider,
  recordRecent = recordRecentSearch
) {
  let revision = 0
  let refreshed: { revision: number; results: MusicItem[] } | null = null
  return create<SearchState>((set, get) => ({
    acceptLocalRefresh: (scope, session, query, results) => {
      const provider = getProvider()
      if (
        provider?.cacheScope !== scope ||
        provider.playbackSession !== session ||
        get().query !== query
      )
        return
      refreshed = { revision, results }
      if (!get().isSearching) set({ results, error: null })
    },
    query: "",
    results: [],
    isSearching: false,
    error: null,
    setQuery: (q) => {
      if (q === get().query) return
      revision++
      set({ query: q, results: [], isSearching: !!q.trim(), error: null })
    },
    search: async (q) => {
      const request = ++revision
      const provider = getProvider()
      if (!q.trim()) {
        set({ query: q, results: [], isSearching: false, error: null })
        return
      }
      if (!provider) {
        set({
          query: q,
          results: [],
          isSearching: false,
          error: "Connect to a music library to search.",
        })
        return
      }
      const current = () =>
        request === revision && getProvider() === provider && get().query === q
      set({ query: q, results: [], isSearching: true, error: null })
      try {
        const results = await provider.search(q)
        if (!current()) return
        set({
          results:
            refreshed?.revision === request ? refreshed.results : results,
          isSearching: false,
        })
        try {
          recordRecent(q)
        } catch {
          /* History storage cannot invalidate successful search results. */
        }
      } catch (error) {
        if (current())
          set({ results: [], error: String(error), isSearching: false })
      }
    },
    clear: () => {
      revision++
      set({ query: "", results: [], isSearching: false, error: null })
    },
  }))
}

export const useSearchStore = createSearchStore()
useProviderStore.subscribe((state, previous) => {
  if (state.provider !== previous.provider) useSearchStore.getState().clear()
})
