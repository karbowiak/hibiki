import { create } from "zustand"
import type { LyricLineData, LyricsSource } from "../providers/types"
import type { GeniusSearchHit } from "../metadata/genius/api"
import { geniusSearch, geniusGetLyrics } from "../metadata/genius/api"
import { useGeniusStore } from "../metadata/genius/authStore"
import { useProviderStore } from "./providerStore"
import { usePlayerStore } from "./playerStore"
import { useUIStore } from "./uiStore"

/** Monotonically increasing generation counter — incremented on every fetchForTrack call.
 *  Any async continuation whose captured generation doesn't match the current one is stale. */
let _fetchGeneration = 0
let _sourceGeneration = 0

interface LyricsState {
  /** All available lyrics sources for the current track. */
  sources: LyricsSource[]
  /** ID of the currently active lyrics source. */
  activeSourceId: string | null
  /** Genius search hits for the current track (for the selector UI). */
  geniusHits: GeniusSearchHit[]
  /** True while searching Genius. */
  isSearching: boolean
  /** True while fetching lyrics from a selected Genius hit. */
  isFetchingLyrics: boolean

  fetchForTrack: (trackId: string, artist: string, title: string) => void
  selectSource: (id: string) => void
  fetchGeniusLyrics: (hit: GeniusSearchHit) => Promise<void>
  clear: () => void
}

export const useLyricsStore = create<LyricsState>((set, get) => ({
  sources: [],
  activeSourceId: null,
  geniusHits: [],
  isSearching: false,
  isFetchingLyrics: false,

  fetchForTrack: (trackId, artist, title) => {
    // Bump generation — all in-flight fetches from previous calls become stale
    const gen = ++_fetchGeneration
    const sourceChoice = ++_sourceGeneration
    const provider = useProviderStore.getState().provider

    // Clear previous state
    set({ sources: [], activeSourceId: null, geniusHits: [], isSearching: false, isFetchingLyrics: false })

    const isStale = () => gen !== _fetchGeneration || useProviderStore.getState().provider !== provider
    const ownsChoice = () => !isStale() && sourceChoice === _sourceGeneration

    void (async () => {
      const genius = useGeniusStore.getState()

      // 1. Fetch Plex lyrics
      let plexLines: LyricLineData[] = []
      if (provider?.getLyrics) {
        try {
          plexLines = await provider.getLyrics(trackId)
        } catch {
          // Plex lyrics not available
        }
      }

      if (isStale()) return

      const sources: LyricsSource[] = []

      if (plexLines.length > 0) {
        const isSynced = plexLines.some(l => l.startMs > 0 || l.endMs > 0)
        sources.push({
          id: "plex",
          label: "Plex",
          lines: plexLines,
          isSynced,
        })
      }

      // Push plex lyrics immediately so the user sees them
      if (sources.length > 0) {
        set({ sources, activeSourceId: "plex" })
        pushLyricsToPlayer(sources[0].lines)
      }

      // 2. If Genius enabled AND (alwaysFetch OR Plex returned empty): search Genius
      // Only fetch from Genius if the lyrics UI is actually visible
      const ui = useUIStore.getState()
      const lyricsVisible = ui.isLyricsOpen || (ui.isQueuePinned && ui.queueActiveTab === "lyrics")
      const shouldSearchGenius = lyricsVisible && genius.hasCredentials && genius.isEnabled &&
        (genius.alwaysFetch || plexLines.length === 0)

      if (!shouldSearchGenius) {
        if (plexLines.length === 0 && ownsChoice()) {
          usePlayerStore.setState({ lyricsLines: [] })
        }
        return
      }

      set({ isSearching: true })

      try {
        const hits = await geniusSearch(artist, title)
        if (isStale()) return

        set({ geniusHits: hits, isSearching: false })

        // Auto-fetch top Genius hit if no Plex lyrics and it's a strong match
        if (plexLines.length === 0 && ownsChoice()) {
          if (hits.length > 0 && hits[0].relevance >= 0.5) {
            // Inline the fetch here so we can check staleness
            const hit = hits[0]
            set({ isFetchingLyrics: true })
            try {
              const geniusLines = await geniusGetLyrics(hit.url)
              if (!ownsChoice()) return

              const lines: LyricLineData[] = geniusLines.map(l => ({
                startMs: 0,
                endMs: 0,
                text: l.text,
              }))
              const source: LyricsSource = {
                id: `genius-${hit.id}`,
                label: hit.title,
                lines,
                isSynced: false,
              }
              const allSources = [...get().sources, source]
              set({ sources: allSources, activeSourceId: source.id, isFetchingLyrics: false })
              pushLyricsToPlayer(lines)
            } catch {
              if (!ownsChoice()) return
              set({ isFetchingLyrics: false })
              usePlayerStore.setState({ lyricsLines: [] })
            }
          } else {
            usePlayerStore.setState({ lyricsLines: [] })
          }
        }
      } catch {
        if (isStale()) return
        set({ isSearching: false })
        if (plexLines.length === 0 && ownsChoice()) {
          usePlayerStore.setState({ lyricsLines: [] })
        }
      }
    })()
  },

  selectSource: (id) => {
    const source = get().sources.find(s => s.id === id)
    if (source) {
      ++_sourceGeneration
      set({ activeSourceId: id, isFetchingLyrics: false })
      pushLyricsToPlayer(source.lines)
    }
  },

  fetchGeniusLyrics: async (hit) => {
    const generation = _fetchGeneration, choice = ++_sourceGeneration
    const provider = useProviderStore.getState().provider
    const current = () => generation === _fetchGeneration && choice === _sourceGeneration && provider === useProviderStore.getState().provider
    const existing = get().sources.find(s => s.id === `genius-${hit.id}`)
    if (existing) {
      set({ activeSourceId: existing.id, isFetchingLyrics: false })
      pushLyricsToPlayer(existing.lines)
      return
    }

    set({ isFetchingLyrics: true })

    try {
      const geniusLines = await geniusGetLyrics(hit.url)
      if (!current()) return
      const lines: LyricLineData[] = geniusLines.map(l => ({
        startMs: 0,
        endMs: 0,
        text: l.text,
      }))

      const source: LyricsSource = {
        id: `genius-${hit.id}`,
        label: hit.title,
        lines,
        isSynced: false,
      }

      const sources = [...get().sources, source]
      set({ sources, activeSourceId: source.id, isFetchingLyrics: false })
      pushLyricsToPlayer(lines)
    } catch {
      if (current()) set({ isFetchingLyrics: false })
    }
  },

  clear: () => {
    ++_fetchGeneration
    ++_sourceGeneration
    set({ sources: [], activeSourceId: null, geniusHits: [], isSearching: false, isFetchingLyrics: false })
  },
}))

function pushLyricsToPlayer(lines: LyricLineData[]) {
  usePlayerStore.setState({ lyricsLines: lines })
}
