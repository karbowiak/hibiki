import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  createPlaylist as createPlaylistApi,
  getHubs,
  getLikedTracks,
  getPlaylistItems,
  getPlaylists,
  getRecentlyAdded,
} from "../lib/plex"
import type { Hub, Playlist, PlexMedia, Track } from "../types/plex"
import { idbJSONStorage } from "./idbStorage"

const TTL_MS = {
  playlists: 5 * 60_000,     //  5 minutes
  recentlyAdded: 10 * 60_000, // 10 minutes
  hubs: 15 * 60_000,          // 15 minutes
  likedTracks: 10 * 60_000,   // 10 minutes
}

/**
 * Playlists at or below this size are loaded in a single request and fully cached.
 * Playlists above this use infinite scroll (INITIAL_PAGE_SIZE first, then PAGE_SIZE pages).
 */
const SMALL_PLAYLIST_THRESHOLD = 1000

/**
 * First-page size for large playlists (> SMALL_PLAYLIST_THRESHOLD).
 * Kept small so even a 50,000-track smart playlist renders the first rows quickly.
 */
const INITIAL_PAGE_SIZE = 50

/** Tracks per page for infinite-scroll fetches on large playlists. */
const PAGE_SIZE = 100

/**
 * Background prefetch is limited to playlists at or below this size.
 * Matches SMALL_PLAYLIST_THRESHOLD so that prefetched playlists are always fully loaded.
 */
const PREFETCH_THRESHOLD = SMALL_PLAYLIST_THRESHOLD

/** Milliseconds between sequential background prefetch requests. */
const PREFETCH_DELAY_MS = 100

interface FetchOpts {
  force?: boolean
}

/**
 * Module-level: deduplicate concurrent first-page fetches for the same playlist.
 * If the user clicks a playlist while a prefetch for it is in-flight, both get
 * the same Promise — no duplicate network request.
 */
const inflight = new Map<number, Promise<Track[]>>()

function fetchInitial(playlistId: number, limit: number): Promise<Track[]> {
  const existing = inflight.get(playlistId)
  if (existing) return existing
  const p = getPlaylistItems(playlistId, limit, 0).finally(() => {
    inflight.delete(playlistId)
  })
  inflight.set(playlistId, p)
  return p
}

interface LibraryState {
  playlists: Playlist[]
  recentlyAdded: PlexMedia[]
  hubs: Hub[]
  likedTracks: Track[]
  currentPlaylist: Playlist | null
  currentPlaylistItems: Track[]
  currentPlaylistId: number | null
  isLoading: boolean
  isFetchingMore: boolean
  error: string | null

  /** Per-playlist track cache. Key = playlist rating_key. */
  playlistItemsCache: Record<number, Track[]>
  /** True once all pages for a playlist have been fetched. */
  playlistIsFullyLoaded: Record<number, boolean>
  /** Shown in TopBar during startup pre-fetch. Null when idle. */
  prefetchStatus: { done: number; total: number } | null

  // TTL timestamps (null = never fetched)
  _playlistsFetchedAt: number | null
  _recentlyAddedFetchedAt: number | null
  _hubsFetchedAt: number | null
  _likedTracksFetchedAt: number | null

  fetchPlaylists: (sectionId: number, opts?: FetchOpts) => Promise<void>
  fetchRecentlyAdded: (sectionId: number, limit?: number, opts?: FetchOpts) => Promise<void>
  fetchHubs: (sectionId: number, opts?: FetchOpts) => Promise<void>
  fetchLikedTracks: (sectionId: number, limit?: number, opts?: FetchOpts) => Promise<void>
  fetchPlaylistItems: (playlistId: number) => Promise<void>
  fetchMorePlaylistItems: (playlistId: number) => Promise<void>
  prefetchAllPlaylists: () => Promise<void>
  createPlaylist: (title: string, sectionId: number) => Promise<Playlist>
  refreshAll: (sectionId: number) => Promise<void>
  /** Null out all TTL timestamps and playlist caches so the next fetch hits the network. */
  invalidateCache: () => void
}

export const useLibraryStore = create<LibraryState>()(persist((set, get) => ({
  playlists: [],
  recentlyAdded: [],
  hubs: [],
  likedTracks: [],
  currentPlaylist: null,
  currentPlaylistItems: [],
  currentPlaylistId: null,
  isLoading: false,
  isFetchingMore: false,
  error: null,
  playlistItemsCache: {},
  playlistIsFullyLoaded: {},
  prefetchStatus: null,
  _playlistsFetchedAt: null,
  _recentlyAddedFetchedAt: null,
  _hubsFetchedAt: null,
  _likedTracksFetchedAt: null,

  fetchPlaylists: async (sectionId: number, opts: FetchOpts = {}) => {
    const { _playlistsFetchedAt } = get()
    if (!opts.force && _playlistsFetchedAt !== null && Date.now() - _playlistsFetchedAt < TTL_MS.playlists) return
    try {
      const playlists = await getPlaylists(sectionId)
      set({ playlists, _playlistsFetchedAt: Date.now() })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  fetchRecentlyAdded: async (sectionId: number, limit = 50, opts: FetchOpts = {}) => {
    const { _recentlyAddedFetchedAt } = get()
    if (!opts.force && _recentlyAddedFetchedAt !== null && Date.now() - _recentlyAddedFetchedAt < TTL_MS.recentlyAdded) return
    try {
      const recentlyAdded = await getRecentlyAdded(sectionId, undefined, limit)
      set({ recentlyAdded, _recentlyAddedFetchedAt: Date.now() })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  fetchHubs: async (sectionId: number, opts: FetchOpts = {}) => {
    const { _hubsFetchedAt } = get()
    if (!opts.force && _hubsFetchedAt !== null && Date.now() - _hubsFetchedAt < TTL_MS.hubs) return
    try {
      const hubs = await getHubs(sectionId)
      set({ hubs, _hubsFetchedAt: Date.now() })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  fetchLikedTracks: async (sectionId: number, limit = 500, opts: FetchOpts = {}) => {
    const { _likedTracksFetchedAt } = get()
    if (!opts.force && _likedTracksFetchedAt !== null && Date.now() - _likedTracksFetchedAt < TTL_MS.likedTracks) return
    try {
      const likedTracks = await getLikedTracks(sectionId, limit)
      set({ likedTracks, _likedTracksFetchedAt: Date.now() })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  fetchPlaylistItems: async (playlistId: number) => {
    const { playlistItemsCache } = get()
    const playlist = get().playlists.find(p => p.rating_key === playlistId) ?? null

    // Always set the current playlist metadata immediately so the header renders.
    set({ currentPlaylist: playlist, currentPlaylistId: playlistId, error: null })

    // Cache hit — show items instantly, no loading state needed.
    if (playlistItemsCache[playlistId]) {
      set({ currentPlaylistItems: playlistItemsCache[playlistId], isLoading: false })
      return
    }

    // Decide fetch strategy: load everything at once for small playlists.
    const totalCount = playlist?.leaf_count ?? 0
    const isSmall = totalCount > 0 && totalCount <= SMALL_PLAYLIST_THRESHOLD
    const limit = isSmall ? totalCount : INITIAL_PAGE_SIZE

    set({ isLoading: true, currentPlaylistItems: [] })
    try {
      const items = await fetchInitial(playlistId, limit)
      const isFullyLoaded = isSmall || items.length < INITIAL_PAGE_SIZE
      set(state => ({
        currentPlaylistItems: items,
        isLoading: false,
        playlistItemsCache: { ...state.playlistItemsCache, [playlistId]: items },
        playlistIsFullyLoaded: { ...state.playlistIsFullyLoaded, [playlistId]: isFullyLoaded },
      }))
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  fetchMorePlaylistItems: async (playlistId: number) => {
    const { playlistItemsCache, playlistIsFullyLoaded, isFetchingMore, isLoading } = get()
    if (isFetchingMore || isLoading) return  // don't overlap with initial page load
    if (playlistIsFullyLoaded[playlistId]) return

    const existing = playlistItemsCache[playlistId] ?? []
    set({ isFetchingMore: true })
    try {
      const items = await getPlaylistItems(playlistId, PAGE_SIZE, existing.length)
      const newAll = [...existing, ...items]
      const isFullyLoaded = items.length < PAGE_SIZE
      set(state => ({
        isFetchingMore: false,
        playlistItemsCache: { ...state.playlistItemsCache, [playlistId]: newAll },
        playlistIsFullyLoaded: { ...state.playlistIsFullyLoaded, [playlistId]: isFullyLoaded },
        // Update the visible list only if this is still the active playlist.
        ...(state.currentPlaylistId === playlistId ? { currentPlaylistItems: newAll } : {}),
      }))
    } catch (err) {
      set({ isFetchingMore: false, error: String(err) })
    }
  },

  /**
   * Background-prefetch all small playlists (leaf_count ≤ PREFETCH_THRESHOLD).
   * Runs sequentially with a short delay between requests so it doesn't saturate
   * the server. Already-cached playlists are skipped.
   */
  prefetchAllPlaylists: async () => {
    const playlists = get().playlists
    const toFetch = playlists
      .filter(p => p.leaf_count <= PREFETCH_THRESHOLD && !get().playlistItemsCache[p.rating_key])
      .sort((a, b) => a.leaf_count - b.leaf_count)

    if (toFetch.length === 0) return

    set({ prefetchStatus: { done: 0, total: toFetch.length } })

    for (let i = 0; i < toFetch.length; i++) {
      const playlist = toFetch[i]

      // Skip if the user already navigated to it and it's now cached.
      if (get().playlistItemsCache[playlist.rating_key]) {
        set({ prefetchStatus: { done: i + 1, total: toFetch.length } })
        continue
      }

      try {
        const limit = playlist.leaf_count > 0 ? playlist.leaf_count : INITIAL_PAGE_SIZE
        const items = await fetchInitial(playlist.rating_key, limit)
        const isFullyLoaded = true  // prefetch only runs for playlists ≤ PREFETCH_THRESHOLD
        set(state => ({
          playlistItemsCache: { ...state.playlistItemsCache, [playlist.rating_key]: items },
          playlistIsFullyLoaded: { ...state.playlistIsFullyLoaded, [playlist.rating_key]: isFullyLoaded },
          prefetchStatus: { done: i + 1, total: toFetch.length },
        }))
      } catch {
        // Don't let one failure abort the entire prefetch run.
        set({ prefetchStatus: { done: i + 1, total: toFetch.length } })
      }

      if (i < toFetch.length - 1) {
        await new Promise<void>(resolve => setTimeout(resolve, PREFETCH_DELAY_MS))
      }
    }

    set({ prefetchStatus: null })
  },

  createPlaylist: async (title: string, sectionId: number) => {
    const playlist = await createPlaylistApi(title, sectionId, [])
    set(state => ({ playlists: [...state.playlists, playlist] }))
    return playlist
  },

  /** Force-refresh all home-page data (used by the Refresh button). */
  refreshAll: async (sectionId: number) => {
    await Promise.all([
      get().fetchPlaylists(sectionId, { force: true }),
      get().fetchRecentlyAdded(sectionId, 50, { force: true }),
      get().fetchHubs(sectionId, { force: true }),
    ])
  },

  invalidateCache: () => set({
    _playlistsFetchedAt: null,
    _recentlyAddedFetchedAt: null,
    _hubsFetchedAt: null,
    _likedTracksFetchedAt: null,
    playlistItemsCache: {},
    playlistIsFullyLoaded: {},
  }),
}), {
  name: "plex-library-v1",
  storage: idbJSONStorage,
  // Persist library data + TTL timestamps. Ephemeral state (loading flags,
  // per-playlist track cache, etc.) is intentionally excluded.
  partialize: (state) => ({
    playlists: state.playlists,
    recentlyAdded: state.recentlyAdded,
    hubs: state.hubs,
    likedTracks: state.likedTracks,
    _playlistsFetchedAt: state._playlistsFetchedAt,
    _recentlyAddedFetchedAt: state._recentlyAddedFetchedAt,
    _hubsFetchedAt: state._hubsFetchedAt,
    _likedTracksFetchedAt: state._likedTracksFetchedAt,
  }),
}))
