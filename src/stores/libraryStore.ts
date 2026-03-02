import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  createPlaylist as createPlaylistApi,
  getHubs,
  getLikedTracks,
  getLikedArtists,
  getLikedAlbums,
  getMixTracks,
  getPlaylistItems,
  getPlaylists,
  getRecentlyAdded,
  getSectionTags,
} from "../lib/plex"
import type { Album, Artist, Hub, LibraryTag, Playlist, PlexMedia, Track } from "../types/plex"

export interface SeedItem {
  rating_key: number
  title: string
  thumb: string | null  // already-resolved pleximg:// URL
  subtitle: string
}

export interface RecentMix {
  id: string
  createdAt: number
  tabType: "artist" | "album" | "track"
  seeds: SeedItem[]
}
import { idbJSONStorage } from "./idbStorage"

const TTL_MS = {
  playlists: 5 * 60_000,           //  5 minutes
  recentlyAdded: 10 * 60_000,      // 10 minutes
  hubs: 15 * 60_000,               // 15 minutes
  likedTracks: 10 * 60_000,        // 10 minutes
  likedArtists: 10 * 60_000,       // 10 minutes
  likedAlbums: 10 * 60_000,        // 10 minutes
  tags: 24 * 60 * 60_000,          // 24 hours
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
  likedArtists: Artist[]
  likedAlbums: Album[]
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
  /** Per-mix track cache. Key = mix item.key (the API path). */
  mixTracksCache: Record<string, Track[]>
  /** Shown in TopBar during startup pre-fetch. Null when idle. */
  prefetchStatus: { done: number; total: number } | null

  // Tag data (genre/mood/style) — pre-loaded with 24h TTL
  tagsGenre: LibraryTag[]
  tagsMood: LibraryTag[]
  tagsStyle: LibraryTag[]

  /** Last 5 custom mixes built by the user in the Mix Builder. Persisted. */
  recentMixes: RecentMix[]

  // TTL timestamps (null = never fetched)
  _playlistsFetchedAt: number | null
  _recentlyAddedFetchedAt: number | null
  _hubsFetchedAt: number | null
  _likedTracksFetchedAt: number | null
  _likedArtistsFetchedAt: number | null
  _likedAlbumsFetchedAt: number | null
  _tagsFetchedAt: number | null

  fetchPlaylists: (sectionId: number, opts?: FetchOpts) => Promise<void>
  fetchRecentlyAdded: (sectionId: number, limit?: number, opts?: FetchOpts) => Promise<void>
  fetchHubs: (sectionId: number, opts?: FetchOpts) => Promise<void>
  fetchLikedTracks: (sectionId: number, limit?: number, opts?: FetchOpts) => Promise<void>
  fetchLikedArtists: (sectionId: number, opts?: FetchOpts) => Promise<void>
  fetchLikedAlbums: (sectionId: number, opts?: FetchOpts) => Promise<void>
  fetchTags: (sectionId: number, opts?: FetchOpts) => Promise<void>
  addRecentMix: (seeds: SeedItem[], tabType: "artist" | "album" | "track") => void
  fetchPlaylistItems: (playlistId: number) => Promise<void>
  fetchMorePlaylistItems: (playlistId: number) => Promise<void>
  prefetchAllPlaylists: () => Promise<void>
  prefetchMixTracks: () => Promise<void>
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
  likedArtists: [],
  likedAlbums: [],
  currentPlaylist: null,
  currentPlaylistItems: [],
  currentPlaylistId: null,
  isLoading: false,
  isFetchingMore: false,
  error: null,
  playlistItemsCache: {},
  playlistIsFullyLoaded: {},
  mixTracksCache: {},
  tagsGenre: [],
  tagsMood: [],
  tagsStyle: [],
  recentMixes: [],
  prefetchStatus: null,
  _playlistsFetchedAt: null,
  _recentlyAddedFetchedAt: null,
  _hubsFetchedAt: null,
  _likedTracksFetchedAt: null,
  _likedArtistsFetchedAt: null,
  _likedAlbumsFetchedAt: null,
  _tagsFetchedAt: null,

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

  fetchLikedArtists: async (sectionId: number, opts: FetchOpts = {}) => {
    const { _likedArtistsFetchedAt } = get()
    if (!opts.force && _likedArtistsFetchedAt !== null && Date.now() - _likedArtistsFetchedAt < TTL_MS.likedArtists) return
    try {
      const likedArtists = await getLikedArtists(sectionId)
      set({ likedArtists, _likedArtistsFetchedAt: Date.now() })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  fetchLikedAlbums: async (sectionId: number, opts: FetchOpts = {}) => {
    const { _likedAlbumsFetchedAt } = get()
    if (!opts.force && _likedAlbumsFetchedAt !== null && Date.now() - _likedAlbumsFetchedAt < TTL_MS.likedAlbums) return
    try {
      const likedAlbums = await getLikedAlbums(sectionId)
      set({ likedAlbums, _likedAlbumsFetchedAt: Date.now() })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  fetchTags: async (sectionId: number, opts: FetchOpts = {}) => {
    const { _tagsFetchedAt, tagsGenre, tagsMood, tagsStyle } = get()
    const isEmpty = tagsGenre.length === 0 && tagsMood.length === 0 && tagsStyle.length === 0
    if (!opts.force && !isEmpty && _tagsFetchedAt !== null && Date.now() - _tagsFetchedAt < TTL_MS.tags) return
    try {
      const [g, m, s] = await Promise.allSettled([
        getSectionTags(sectionId, "genre"),
        getSectionTags(sectionId, "mood"),
        getSectionTags(sectionId, "style"),
      ])
      set({
        tagsGenre: g.status === "fulfilled" ? g.value.sort((a, b) => a.tag.localeCompare(b.tag)) : get().tagsGenre,
        tagsMood:  m.status === "fulfilled" ? m.value.sort((a, b) => a.tag.localeCompare(b.tag)) : get().tagsMood,
        tagsStyle: s.status === "fulfilled" ? s.value.sort((a, b) => a.tag.localeCompare(b.tag)) : get().tagsStyle,
        _tagsFetchedAt: Date.now(),
      })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  addRecentMix: (seeds, tabType) => {
    const seedSig = seeds.map(s => s.rating_key).sort().join(",")
    const entry: RecentMix = { id: String(Date.now()), createdAt: Date.now(), tabType, seeds }
    set(state => {
      const filtered = state.recentMixes.filter(
        m => m.seeds.map(s => s.rating_key).sort().join(",") !== seedSig
      )
      return { recentMixes: [entry, ...filtered].slice(0, 5) }
    })
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

  /**
   * Background-prefetch track lists for all mix hub items.
   * Runs sequentially with a short delay. Already-cached mixes are skipped.
   */
  prefetchMixTracks: async () => {
    const { hubs, mixTracksCache } = get()
    const mixItems = hubs
      .filter(h => h.hub_identifier.startsWith("music.mixes"))
      .flatMap(h => h.metadata)
      .filter(item => item.type === "playlist" && item.key && !mixTracksCache[item.key])

    for (let i = 0; i < mixItems.length; i++) {
      const item = mixItems[i]
      if (item.type !== "playlist" || !item.key) continue
      if (get().mixTracksCache[item.key]) continue  // already fetched by concurrent path

      try {
        const tracks = await getMixTracks(item.key)
        set(state => ({
          mixTracksCache: { ...state.mixTracksCache, [item.key]: tracks },
        }))
      } catch {
        // Don't abort remaining mixes on failure
      }

      if (i < mixItems.length - 1) {
        await new Promise<void>(resolve => setTimeout(resolve, PREFETCH_DELAY_MS))
      }
    }
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
    _likedArtistsFetchedAt: null,
    _likedAlbumsFetchedAt: null,
    _tagsFetchedAt: null,
    playlistItemsCache: {},
    playlistIsFullyLoaded: {},
    mixTracksCache: {},
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
    likedArtists: state.likedArtists,
    likedAlbums: state.likedAlbums,
    tagsGenre: state.tagsGenre,
    tagsMood: state.tagsMood,
    tagsStyle: state.tagsStyle,
    recentMixes: state.recentMixes,
    _playlistsFetchedAt: state._playlistsFetchedAt,
    _recentlyAddedFetchedAt: state._recentlyAddedFetchedAt,
    _hubsFetchedAt: state._hubsFetchedAt,
    _likedTracksFetchedAt: state._likedTracksFetchedAt,
    _likedArtistsFetchedAt: state._likedArtistsFetchedAt,
    _likedAlbumsFetchedAt: state._likedAlbumsFetchedAt,
    _tagsFetchedAt: state._tagsFetchedAt,
  }),
}))
