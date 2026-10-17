import { create } from "zustand"
import type { LyricLineData, LyricsSource } from "../providers/types"
import type { GeniusSearchHit } from "../metadata/genius/api"
import { geniusSearch, geniusGetLyrics } from "../metadata/genius/api"
import { useGeniusStore } from "../metadata/genius/authStore"
import { useProviderStore } from "./providerStore"
import { usePlayerStore } from "./playerStore"
import { useUIStore } from "./uiStore"
import { isYoutubeMusicId } from "../backends/ytmusic/tracks"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"

/** Monotonically increasing generation counter — incremented on every fetchForTrack call.
 *  Any async continuation whose captured generation doesn't match the current one is stale. */
let _fetchGeneration = 0
let _sourceGeneration = 0

interface LyricsState {
  /** All available lyrics sources for the current track. */
  error: string | null
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
  error: null,
  sources: [],
  activeSourceId: null,
  geniusHits: [],
  isSearching: false,
  isFetchingLyrics: false,

  fetchForTrack: (trackId, artist, title) => {
    const gen = ++_fetchGeneration, sourceChoice = ++_sourceGeneration
    const provider = useProviderStore.getState().provider
    const session = provider?.playbackSession, scope = provider?.cacheScope
    const youtube = useYoutubeMusicDiscoveryStore.getState()
    const independent = isYoutubeMusicId(trackId)
    const track = usePlayerStore.getState().currentTrack
    set({ sources: [], activeSourceId: null, geniusHits: [], isSearching: false, isFetchingLyrics: true, error: null })
    const isStale = () => gen !== _fetchGeneration || useProviderStore.getState().provider !== provider ||
      provider?.playbackSession !== session || provider?.cacheScope !== scope ||
      (independent && (useYoutubeMusicDiscoveryStore.getState().revision !== youtube.revision ||
        useYoutubeMusicDiscoveryStore.getState().accountId !== youtube.accountId ||
        useYoutubeMusicDiscoveryStore.getState().connected !== youtube.connected))
    const ownsChoice = () => !isStale() && sourceChoice === _sourceGeneration
    const add = (source: LyricsSource) => {
      if (isStale() || !source.lines.some(line => line.text.trim())) return
      set({ sources: [...get().sources.filter(item => item.id !== source.id), source] })
      if (ownsChoice() && !get().activeSourceId) {
        set({ activeSourceId: source.id })
        pushLyricsToPlayer(source.lines)
      }
    }
    void (async () => {
      try {
        if (independent && youtube.connected) {
          try {
            const { youtubeMusicLyrics } = await import("../backends/ytmusic/lyrics")
            const result = await youtubeMusicLyrics(trackId)
            if (isStale()) return
            if (!result.missing) add({ id: "ytmusic", label: "YouTube Music", lines: result.lines,
              isSynced: result.lines.some(line => line.startMs > 0 || line.endMs > 0) })
          } catch {
            if (isStale()) return
            set({ error: "YouTube Music lyrics could not be loaded. Trying other sources." })
          }
        }
        // A YouTube video ID must never be sent to Plex's metadata endpoint.
        let plexId = independent ? null : trackId
        if (independent && !get().sources.length && provider?.getLyrics && !provider.isOffline && track?.id === trackId) {
          try {
            const { resolveCounterpart } = await import("../mixedPlaylists/counterparts")
            const match = await resolveCounterpart(track, "plex")
            if (isStale()) return
            if (match.status === "matched") plexId = match.track.id
          } catch { /* Missing/ambiguous matches go straight to Genius. */ }
        }
        if (isStale()) return
        if (!get().sources.length && plexId && provider?.getLyrics) {
          try {
            const lines = await provider.getLyrics(plexId)
            if (isStale()) return
            add({ id: "plex", label: "Plex", lines, isSynced: lines.some(line => line.startMs > 0 || line.endMs > 0) })
          } catch { /* The fallback remains available without Plex lyrics. */ }
        }
        if (isStale()) return
        const genius = useGeniusStore.getState(), ui = useUIStore.getState()
        const visible = ui.isLyricsOpen || (ui.isQueuePinned && ui.queueActiveTab === "lyrics")
        if (!visible || !genius.hasCredentials || !genius.isEnabled || (!genius.alwaysFetch && get().sources.length)) return
        set({ isSearching: true })
        try {
          const hits = await geniusSearch(artist, title)
          if (isStale()) return
          set({ geniusHits: hits, isSearching: false })
          if (!get().sources.length && ownsChoice() && hits[0]?.relevance >= 0.5) {
            const hit = hits[0]
            const raw = await geniusGetLyrics(hit.url)
            if (!ownsChoice()) return
            add({ id: `genius-${hit.id}`, label: "Genius", isSynced: false,
              lines: raw.map(line => ({ startMs: 0, endMs: 0, text: line.text })) })
          }
        } catch {
          if (!isStale()) set({ isSearching: false, error: "Genius lyrics could not be loaded." })
        }
      } finally {
        if (!isStale()) {
          set({ isSearching: false, ...(ownsChoice() ? { isFetchingLyrics: false } : {}) })
          if (!get().sources.length && ownsChoice()) pushLyricsToPlayer([])
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
    const session = provider?.playbackSession, scope = provider?.cacheScope
    const youtube = useYoutubeMusicDiscoveryStore.getState()
    const current = () => provider?.playbackSession === session && provider?.cacheScope === scope &&
      youtube.revision === useYoutubeMusicDiscoveryStore.getState().revision && youtube.accountId === useYoutubeMusicDiscoveryStore.getState().accountId && generation === _fetchGeneration && choice === _sourceGeneration && provider === useProviderStore.getState().provider
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
        label: "Genius",
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
    set({ sources: [], activeSourceId: null, geniusHits: [], isSearching: false, isFetchingLyrics: false, error: null })
  },
}))

function pushLyricsToPlayer(lines: LyricLineData[]) {
  usePlayerStore.setState({ lyricsLines: lines })
}

// An account replacement retires visible lyrics as well as in-flight requests.
useYoutubeMusicDiscoveryStore.subscribe((state, previous) => {
  const track = usePlayerStore.getState().currentTrack
  if ((state.revision !== previous.revision || state.accountId !== previous.accountId || state.connected !== previous.connected) &&
    track && isYoutubeMusicId(track.id)) {
    useLyricsStore.getState().clear()
    usePlayerStore.setState({ lyricsLines: [] })
    if (state.connected) useLyricsStore.getState().fetchForTrack(track.id, track.originalTitle || track.artistName, track.title)
  }
})
