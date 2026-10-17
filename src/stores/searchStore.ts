import { create } from "zustand"
import { recordRecentSearch } from "../lib/recentSearches"
import type { MusicItem } from "../types/music"
import type { MusicProvider } from "../providers/types"
import { useProviderStore } from "./providerStore"
import { browseYoutubeMusic, subscribeYoutubeMusicCatalog, useYoutubeMusicDiscoveryStore, youtubeMusicItemMusic } from "../backends/ytmusic/discovery"
import { mergeMusicSearchResults } from "../lib/musicMatching"

interface SearchState {
  query: string
  results: MusicItem[]
  isSearching: boolean
  error: string | null
  setQuery: (q: string) => void
  search: (q: string, force?: boolean) => Promise<void>
  clear: () => void
  acceptSupplementalRefresh: (query: string, results: MusicItem[]) => void
  acceptLocalRefresh: (
    scope: string,
    session: unknown,
    query: string,
    results: MusicItem[]
  ) => void
}

interface SupplementalSearch {
  owner(): string | null
  search(query: string, force: boolean): Promise<MusicItem[]>
  merge(primary: MusicItem[], supplemental: MusicItem[]): MusicItem[]
}

export function createSearchStore(
  getProvider: () => MusicProvider | null = () =>
    useProviderStore.getState().provider,
  recordRecent = recordRecentSearch,
  supplemental?: SupplementalSearch
) {
  let revision = 0
  let refreshed: { revision: number; results: MusicItem[] } | null = null
  let primary: MusicItem[] = [], secondary: MusicItem[] = []
  const combined = () => supplemental ? supplemental.merge(primary, secondary) : primary
  return create<SearchState>((set, get) => ({
    acceptSupplementalRefresh: (query, results) => {
      if (get().query.trim() !== query || !supplemental?.owner() || getProvider()?.isOffline) return
      secondary = results
      set({ results: combined(), error: null })
    },
    acceptLocalRefresh: (scope, session, query, results) => {
      const provider = getProvider()
      if (
        provider?.cacheScope !== scope ||
        provider.playbackSession !== session ||
        get().query !== query
      )
        return
      refreshed = { revision, results }
      primary = results
      set({ results: combined(), error: null })
    },
    query: "",
    results: [],
    isSearching: false,
    error: null,
    setQuery: (q) => {
      if (q === get().query) return
      revision++
      primary = []; secondary = []
      set({ query: q, results: [], isSearching: !!q.trim(), error: null })
    },
    search: async (q, force = false) => {
      const request = ++revision
      const provider = getProvider()
      const session = provider?.playbackSession, scope = provider?.cacheScope
      const extraOwner = !provider?.isOffline ? supplemental?.owner() ?? null : null
      if (!q.trim()) {
        primary = []; secondary = []
        set({ query: q, results: [], isSearching: false, error: null })
        return
      }
      if (!provider && extraOwner === null) {
        set({
          query: q,
          results: [],
          isSearching: false,
          error: "Connect to a music library to search.",
        })
        return
      }
      const current = () =>
        request === revision && getProvider() === provider && provider?.playbackSession === session &&
        provider?.cacheScope === scope && get().query === q && (extraOwner === null || supplemental?.owner() === extraOwner)
      const previous = q === get().query ? get().results : []
      primary = []; secondary = []
      set({ query: q, results: previous, isSearching: true, error: null })
      let remaining = Number(!!provider) + Number(extraOwner !== null), successes = 0
      const failures: string[] = []
      const publish = () => {
        if (!current()) return
        const results = combined()
        set({ results, isSearching: remaining > 0, error: !remaining && !results.length && failures.length ? failures.join(" · ") : null })
      }
      const run = async (source: string, load: () => Promise<MusicItem[]>, apply: (items: MusicItem[]) => void) => {
        try {
          const results = await load()
          if (current()) { apply(results); successes++ }
        } catch (error) { if (current()) failures.push(`${source}: ${String(error)}`) }
        finally { remaining--; publish() }
      }
      await Promise.allSettled([
        ...(provider ? [run(provider.name || "Library", () => provider.search(q), results => {
          primary = refreshed?.revision === request ? refreshed.results : results
        })] : []),
        ...(extraOwner !== null ? [run("YouTube Music", () => supplemental!.search(q, force), results => { secondary = results })] : []),
      ])
      if (current() && successes) {
        try {
          recordRecent(q)
        } catch {
          /* History storage cannot invalidate successful search results. */
        }
      }
    },
    clear: () => {
      revision++
      primary = []; secondary = []
      set({ query: "", results: [], isSearching: false, error: null })
    },
  }))
}

export const useSearchStore = createSearchStore(() => useProviderStore.getState().provider, recordRecentSearch, {
  owner: () => {
    const state = useYoutubeMusicDiscoveryStore.getState()
    return state.connected ? `ytmusic:${state.revision}` : null
  },
  search: async (query, force) => (await browseYoutubeMusic({ browseId: "hibiki_search", params: query.trim() }, null, force)).items.map(youtubeMusicItemMusic),
  merge: mergeMusicSearchResults,
})
useProviderStore.subscribe((state, previous) => {
  if (state.provider !== previous.provider) useSearchStore.getState().clear()
})
useYoutubeMusicDiscoveryStore.subscribe((state, previous) => {
  if (state.connected !== previous.connected || state.revision !== previous.revision) {
    const query = useSearchStore.getState().query
    if (query.trim()) void useSearchStore.getState().search(query)
  }
})
subscribeYoutubeMusicCatalog(update => {
  const state = useSearchStore.getState()
  if (update.browseId === "hibiki_search" && update.params === state.query.trim())
    state.acceptSupplementalRefresh(update.params, update.page.items.map(youtubeMusicItemMusic))
})
