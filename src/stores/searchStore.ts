import { create } from "zustand"
import { recordRecentSearch } from "../lib/recentSearches"
import type { MusicItem } from "../types/music"
import type { MusicProvider } from "../providers/types"
import { useProviderStore } from "./providerStore"
import { browseYoutubeMusic, subscribeYoutubeMusicCatalog, useYoutubeMusicDiscoveryStore, youtubeMusicItemMusic } from "../backends/ytmusic/discovery"
import { mergeMusicSearchResults } from "../lib/musicMatching"
import { associateMusicItems } from "../matching/associations"
import { subscribeMatchingUpdates } from "../matching/updates"
import { presentSearchSuggestions } from "../lib/searchSuggestions"
import { useUIStore } from "./uiStore"
import { linkSearchPlaylists } from "../lib/searchPlaylists"
import { useMixedPlaylistStore } from "./mixedPlaylistStore"
import { verifySearchAudio } from "../backends/ytmusic/audioQuality"

interface SearchState {
  query: string
  results: MusicItem[]
  suggestions: MusicItem[]
  context: number
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
  refreshAssociations(): Promise<void>
}

interface SupplementalSearch {
  owner(): string | null
  search(query: string, force: boolean): Promise<MusicItem[]>
  merge(primary: MusicItem[], supplemental: MusicItem[], associations?: ReadonlyMap<string, string | null>): MusicItem[]
  associate?: (items: MusicItem[], current: () => boolean) => Promise<Map<string, string | null>>
  quality?: (primary: MusicItem[], secondary: MusicItem[], associations: ReadonlyMap<string, string | null>, provider: MusicProvider, owner: string, current: () => boolean) => Promise<MusicItem[]>
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
  let associations: Map<string, string | null> | undefined, associationRevision = 0
  let searchOwner: { provider: MusicProvider | null; session: unknown; scope: unknown; extra: string | null } | null = null
  const combined = () => supplemental ? supplemental.merge(primary, secondary, associations) : primary
  const suggest = (_previous: MusicItem[], incoming: MusicItem[]) => presentSearchSuggestions(incoming, useUIStore.getState().deduplicateAlbums)
  return create<SearchState>((set, get) => ({
    refreshAssociations: async () => {
      if (!supplemental?.associate || !secondary.length) return
      const request = ++associationRevision, search = revision, rows = secondary
      const provider = getProvider(), scope = provider?.cacheScope, session = provider?.playbackSession, owner = supplemental.owner()
      const current = () => request === associationRevision && search === revision && rows === secondary && getProvider() === provider &&
        provider?.cacheScope === scope && provider?.playbackSession === session && supplemental.owner() === owner
      const results = await supplemental.associate(rows, current)
      if (current()) { associations = results; const merged = combined(); set({ results: merged, suggestions: suggest(get().suggestions, merged) }) }
      if (current() && supplemental.quality && provider && owner) {
        const verified = await supplemental.quality(primary, rows, results, provider, owner, current)
        if (current()) { secondary = verified; const merged = combined(); set({ results: merged, suggestions: suggest(get().suggestions, merged) }) }
      }
    },
    acceptSupplementalRefresh: (query, results) => {
      if (get().query.trim() !== query || !supplemental?.owner() || getProvider()?.isOffline) return
      secondary = results
      associations = undefined
      set({ results: combined(), suggestions: suggest(get().suggestions, combined()), error: null })
      void get().refreshAssociations().catch(() => {})
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
      set({ results: combined(), suggestions: suggest(get().suggestions, combined()), error: null })
    },
    query: "",
    results: [],
    suggestions: [],
    context: 0,
    isSearching: false,
    error: null,
    setQuery: (q) => {
      if (q === get().query) return
      revision++
      primary = []; secondary = []; associations = undefined
      set({ query: q, results: [], suggestions: [], context: get().context + 1, isSearching: !!q.trim(), error: null })
    },
    search: async (q, force = false) => {
      const request = ++revision
      const provider = getProvider()
      const session = provider?.playbackSession, scope = provider?.cacheScope
      const extraOwner = !provider?.isOffline ? supplemental?.owner() ?? null : null
      const sameOwner = searchOwner?.provider === provider && searchOwner?.session === session && searchOwner?.scope === scope && searchOwner?.extra === extraOwner
      const sameContext = sameOwner && q === get().query
      searchOwner = { provider, session, scope, extra: extraOwner }
      if (!sameContext) set({ suggestions: [], context: get().context + 1 })
      if (!q.trim()) {
        primary = []; secondary = []
        set({ query: q, results: [], suggestions: [], isSearching: false, error: null })
        return
      }
      if (!provider && extraOwner === null) {
        set({
          query: q,
          results: [],
          suggestions: [],
          isSearching: false,
          error: "Connect to a music library to search.",
        })
        return
      }
      const current = () =>
        request === revision && getProvider() === provider && provider?.playbackSession === session &&
        provider?.cacheScope === scope && get().query === q && (extraOwner === null || supplemental?.owner() === extraOwner)
      const previous = sameContext ? get().results : []
      primary = []; secondary = []; associations = undefined
      set({ query: q, results: previous, isSearching: true, error: null })
      let remaining = Number(!!provider) + Number(extraOwner !== null), successes = 0
      const failures: string[] = []
      const publish = () => {
        if (!current()) return
        const results = combined()
        set({ results, suggestions: suggest(get().suggestions, results), isSearching: remaining > 0, error: !remaining && failures.length ? failures.join(" · ") : null })
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
      if (current()) void get().refreshAssociations().catch(() => {})
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
      primary = []; secondary = []; associations = undefined
      set({ query: "", results: [], suggestions: [], context: get().context + 1, isSearching: false, error: null })
    },
  }))
}

export const useSearchStore = createSearchStore(() => useProviderStore.getState().provider, recordRecentSearch, {
  owner: () => {
    const state = useYoutubeMusicDiscoveryStore.getState()
    return state.connected ? `ytmusic:${state.revision}` : null
  },
  search: async (query, force) => (await browseYoutubeMusic({ browseId: "hibiki_search", params: query.trim() }, null, force)).items.map(youtubeMusicItemMusic),
  merge: (primary, supplemental, associations) => linkSearchPlaylists(mergeMusicSearchResults(primary, supplemental, associations),
    useMixedPlaylistStore.getState().playlists, {
      plex: useProviderStore.getState().provider?.cacheScope,
      ytmusic: useYoutubeMusicDiscoveryStore.getState().connected ? useYoutubeMusicDiscoveryStore.getState().accountId ?? undefined : undefined,
    }),
  associate: associateMusicItems,
  quality: verifySearchAudio,
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
subscribeMatchingUpdates(update => {
  if (update.provider === useProviderStore.getState().provider && useSearchStore.getState().query.trim())
    void useSearchStore.getState().refreshAssociations().catch(() => {})
})
