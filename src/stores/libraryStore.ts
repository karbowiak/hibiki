import { create } from "zustand"
import type { StateStorage } from "zustand/middleware"
import type { MusicProvider } from "../providers/types"
import { ScopedPersistence } from "./scopedPersistence"
import type { MusicPlaylist, MusicTrack, MusicAlbum, MusicArtist, MusicItem, MusicHub } from "../types/music"
import { useProviderStore } from "./providerStore"
import { idbStorage } from "./idbStorage"

export interface SeedItem {
  id: string
  title: string
  thumb: string | null // already-resolved image:// URL
  subtitle: string
}

export interface RecentMix {
  id: string
  createdAt: number
  tabType: "artist" | "album" | "track"
  seeds: SeedItem[]
}

const TTL_MS = {
  playlists: 5 * 60_000, //  5 minutes
  recentlyAdded: 10 * 60_000, // 10 minutes
  hubs: 15 * 60_000, // 15 minutes
  likedTracks: 10 * 60_000, // 10 minutes
  likedArtists: 10 * 60_000, // 10 minutes
  likedAlbums: 10 * 60_000, // 10 minutes
  tags: 24 * 60 * 60_000 // 24 hours
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

export interface LibraryState {
  activateProvider: (provider: MusicProvider) => Promise<void>
  playlists: MusicPlaylist[]
  recentlyAdded: MusicItem[]
  hubs: MusicHub[]
  likedTracks: MusicTrack[]
  likedArtists: MusicArtist[]
  likedAlbums: MusicAlbum[]
  currentPlaylist: MusicPlaylist | null
  currentPlaylistItems: MusicTrack[]
  currentPlaylistId: string | null
  isLoading: boolean
  isFetchingMore: boolean
  error: string | null

  /** Per-playlist track cache. Key = playlist id. */
  playlistItemsCache: Record<string, MusicTrack[]>
  /** True once all pages for a playlist have been fetched. */
  playlistIsFullyLoaded: Record<string, boolean>
  /** Per-mix track cache. Key = mix item key (the API path). */
  mixTracksCache: Record<string, MusicTrack[]>
  /** Shown in TopBar during startup pre-fetch. Null when idle. */
  prefetchStatus: { done: number; total: number } | null

  // Tag data (genre/mood/style) — pre-loaded with 24h TTL
  tagsGenre: { tag: string; count: number | null }[]
  tagsMood: { tag: string; count: number | null }[]
  tagsStyle: { tag: string; count: number | null }[]

  /** Last 5 custom mixes built by the user in the Mix Builder. Persisted. */
  recentMixes: RecentMix[]

  // WebSocket-driven state
  libraryScanning: boolean
  libraryScanProgress: number | null
  wsConnected: boolean

  setLibraryScanning: (scanning: boolean, progress: number | null) => void
  setWsConnected: (connected: boolean) => void

  // TTL timestamps (null = never fetched)
  _playlistsFetchedAt: number | null
  _recentlyAddedFetchedAt: number | null
  _recentlyAddedLimit: number | undefined
  _hubsFetchedAt: number | null
  _likedTracksFetchedAt: number | null
  _likedTracksLimit: number | undefined
  _likedArtistsFetchedAt: number | null
  _likedArtistsLimit: number | undefined
  _likedAlbumsFetchedAt: number | null
  _likedAlbumsLimit: number | undefined
  _tagsFetchedAt: number | null

  fetchPlaylists: (opts?: FetchOpts) => Promise<void>
  fetchRecentlyAdded: (limit?: number, opts?: FetchOpts) => Promise<void>
  fetchHubs: (opts?: FetchOpts) => Promise<void>
  fetchLikedTracks: (limit?: number, opts?: FetchOpts) => Promise<void>
  fetchLikedArtists: (limit?: number, opts?: FetchOpts) => Promise<void>
  fetchLikedAlbums: (limit?: number, opts?: FetchOpts) => Promise<void>
  fetchTags: (opts?: FetchOpts) => Promise<void>
  addRecentMix: (seeds: SeedItem[], tabType: "artist" | "album" | "track") => void
  fetchPlaylistItems: (playlistId: string) => Promise<void>
  fetchMorePlaylistItems: (playlistId: string) => Promise<void>
  prefetchAllPlaylists: () => Promise<void>
  prefetchMixTracks: () => Promise<void>
  createPlaylist: (title: string) => Promise<MusicPlaylist>
  refreshAll: () => Promise<void>
  /** Evict a single playlist's item cache and refetch if it's currently viewed. */
  invalidatePlaylistItems: (playlistId: string) => void
  /** Remove a playlist from the sidebar list and clean its item cache. */
  removePlaylist: (id: string) => void
  /** Rename a playlist in the sidebar list. */
  renamePlaylist: (id: string, newTitle: string) => void
  /** Optimistically reorder a track within the current playlist items. */
  reorderPlaylistItems: (playlistId: string, fromIndex: number, toIndex: number) => void
  /** Called after any rating change to update cached data. */
  onItemRated: (id: string, itemType: "track" | "album" | "artist", newRating: number | null) => void
  /** Null out all TTL timestamps and playlist caches so the next fetch hits the network. */
  invalidateCache: () => void
  /** Null out only library content TTLs (playlists/recentlyAdded/hubs). Does NOT wipe item caches. */
  invalidateLibraryTTLs: () => void
  /** Wipe all library data and caches. Call on disconnect / backend switch. */
  clearAll: () => void
}

const emptyLibrary = () => ({
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
  libraryScanning: false,
  libraryScanProgress: null,
  wsConnected: false,
  _playlistsFetchedAt: null,
  _recentlyAddedFetchedAt: null,
  _recentlyAddedLimit: undefined,
  _hubsFetchedAt: null,
  _likedTracksFetchedAt: null,
  _likedTracksLimit: undefined,
  _likedArtistsFetchedAt: null,
  _likedArtistsLimit: undefined,
  _likedAlbumsFetchedAt: null,
  _likedAlbumsLimit: undefined,
  _tagsFetchedAt: null
})

const persistedFields = [
  "playlists",
  "recentlyAdded",
  "hubs",
  "likedTracks",
  "likedArtists",
  "likedAlbums",
  "tagsGenre",
  "tagsMood",
  "tagsStyle",
  "recentMixes",
  "_playlistsFetchedAt",
  "_recentlyAddedFetchedAt",
  "_recentlyAddedLimit",
  "_hubsFetchedAt",
  "_likedTracksFetchedAt",
  "_likedTracksLimit",
  "_likedArtistsFetchedAt",
  "_likedArtistsLimit",
  "_likedAlbumsFetchedAt",
  "_likedAlbumsLimit",
  "_tagsFetchedAt"
] as const

function restoreLibrary(value: unknown): Partial<LibraryState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const saved = value as Record<string, unknown>,
    restored: Record<string, unknown> = {}
  const item = (entry: any) => entry && typeof entry.id === "string" && typeof entry.title === "string"
  for (const field of persistedFields) {
    const data = saved[field]
    if (field.endsWith("FetchedAt")) {
      restored[field] =
        typeof data === "number" && Number.isFinite(data) && data >= 0 && data <= Date.now() ? data : null
    } else if (field.endsWith("Limit")) {
      restored[field] = typeof data === "number" && Number.isSafeInteger(data) && data >= 0 ? data : undefined
    } else if (Array.isArray(data)) {
      if (field === "hubs")
        restored[field] = data
          .filter((hub) => hub && typeof hub.identifier === "string" && Array.isArray(hub.items))
          .map((hub) => ({ ...hub, items: hub.items.filter(item) }))
      else if (field.startsWith("tags"))
        restored[field] = data.filter(
          (tag) => tag && typeof tag.tag === "string" && (tag.count === null || Number.isFinite(tag.count))
        )
      else if (field === "recentMixes")
        restored[field] = data
          .filter(
            (mix) =>
              mix &&
              typeof mix.id === "string" &&
              Number.isFinite(mix.createdAt) &&
              ["artist", "album", "track"].includes(mix.tabType) &&
              Array.isArray(mix.seeds) &&
              mix.seeds.every((seed: any) => item(seed) && typeof seed.subtitle === "string")
          )
          .slice(0, 5)
      else restored[field] = data.filter(item)
    }
  }
  for (const kind of ["Tracks", "Artists", "Albums"] as const) {
    const key = `_liked${kind}Limit`
    if (restored[key] === undefined)
      restored[key] = (restored[`liked${kind}`] as unknown[] | undefined)?.length
  }
  if (restored._recentlyAddedLimit === undefined)
    restored._recentlyAddedLimit = (restored.recentlyAdded as unknown[] | undefined)?.length
  return restored as Partial<LibraryState>
}

interface LibraryDependencies {
  getProvider(): MusicProvider | null
  storage?: StateStorage
  delay?: (milliseconds: number) => Promise<void>
}

export function createLibraryStore({
  getProvider,
  storage,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}: LibraryDependencies) {
  const cache = new ScopedPersistence(storage, "hibiki-library-v2")
  let epoch = 0,
    view = 0,
    activeProvider: MusicProvider | null = null
  const requests = new Map<string, { token: symbol; limit: number; promise: Promise<void> }>()
  const initialRequests = new Map<string, Promise<{ items: MusicTrack[]; complete: boolean }>>()
  const versions = new Map<string, number>()
  const moreRequests = new Map<string, symbol>()
  const ratings = new Map<string, number | null>()
  let playlistPrefetch: Promise<void> | null = null,
    mixPrefetch: Promise<void> | null = null
  const version = (id: string) => versions.get(id) ?? 0
  const rated = (tracks: MusicTrack[]) =>
    tracks.map((track) => (ratings.has(track.id) ? { ...track, userRating: ratings.get(track.id)! } : track))
  const capture = () => {
    const provider = getProvider()
    return provider && provider === activeProvider ? { provider, epoch } : null
  }
  const current = (session: { provider: MusicProvider; epoch: number }) =>
    epoch === session.epoch && activeProvider === session.provider && getProvider() === session.provider
  const retire = () => {
    epoch++
    view++
    requests.clear()
    initialRequests.clear()
    versions.clear()
    moreRequests.clear()
    ratings.clear()
    playlistPrefetch = null
    mixPrefetch = null
  }

  const store = create<LibraryState>((set, get) => {
    const fresh = (timestamp: number | null, ttl: number) =>
      timestamp !== null && Date.now() - timestamp < ttl
    async function fetchValue<T>(
      key: string,
      force: boolean,
      limit: number,
      load: (provider: MusicProvider) => Promise<T>,
      commit: (value: T) => void
    ) {
      const session = capture()
      if (!session) return
      const existing = requests.get(key)
      if (!force && existing && existing.limit >= limit) return existing.promise
      const request = { token: Symbol(key), limit, promise: Promise.resolve() }
      requests.set(key, request)
      const valid = () => current(session) && requests.get(key) === request
      request.promise = (async () => {
        try {
          const value = await load(session.provider)
          if (valid()) commit(value)
        } catch (error) {
          if (valid()) set({ error: String(error) })
        } finally {
          if (requests.get(key) === request) requests.delete(key)
        }
      })()
      return request.promise
    }

    function firstPage(
      session: { provider: MusicProvider; epoch: number },
      id: string,
      limit: number,
      total: number
    ) {
      const revision = version(id),
        key = JSON.stringify([id, revision, limit])
      const existing = initialRequests.get(key)
      if (existing) return existing
      const request = (async () => {
        const response = await session.provider.getPlaylistItems(id, 0, limit)
        if (!current(session) || version(id) !== revision) throw new Error("Library request was superseded")
        const items = rated(response.items)
        const complete = total > 0 ? items.length >= total || items.length === 0 : items.length < limit
        set((state) => {
          const previous = state.playlistItemsCache[id]
          if (previous && previous.length > items.length) return {}
          return {
            playlistItemsCache: { ...state.playlistItemsCache, [id]: items },
            playlistIsFullyLoaded: { ...state.playlistIsFullyLoaded, [id]: complete },
            ...(state.currentPlaylistId === id ? { currentPlaylistItems: items, isLoading: false } : {})
          }
        })
        return { items, complete }
      })().finally(() => {
        if (initialRequests.get(key) === request) initialRequests.delete(key)
      })
      initialRequests.set(key, request)
      return request
    }

    const bumpPlaylist = (id: string) => {
      versions.set(id, version(id) + 1)
      moreRequests.delete(id)
    }
    return {
      ...emptyLibrary(),
      activateProvider: async (provider) => {
        const loading = cache.activate(provider.cacheScope ?? null)
        retire()
        activeProvider = provider
        const activation = epoch
        set(emptyLibrary())
        const initial = get()
        const saved = await loading
        if (epoch === activation && activeProvider === provider) {
          const restored = restoreLibrary(saved),
            now = get()
          const patch = Object.fromEntries(
            Object.entries(restored).filter(([key]) => now[key] === initial[key])
          )
          set(patch)
          const id = get().currentPlaylistId
          if (id) set({ currentPlaylist: get().playlists.find((playlist) => playlist.id === id) ?? null })
        }
      },
      setLibraryScanning: (scanning, progress) =>
        set({ libraryScanning: scanning, libraryScanProgress: scanning ? progress : null }),
      setWsConnected: (connected) => set({ wsConnected: connected }),
      fetchPlaylists: async (opts = {}) => {
        if (!opts.force && fresh(get()._playlistsFetchedAt, TTL_MS.playlists)) return
        return fetchValue(
          "playlists",
          !!opts.force,
          0,
          (provider) => provider.getPlaylists(),
          (playlists) =>
            set((state) => ({
              playlists,
              _playlistsFetchedAt: Date.now(),
              currentPlaylist: state.currentPlaylistId
                ? (playlists.find((playlist) => playlist.id === state.currentPlaylistId) ?? null)
                : null
            }))
        )
      },
      fetchRecentlyAdded: async (limit = 50, opts = {}) => {
        if (
          !opts.force &&
          (get()._recentlyAddedLimit ?? 0) >= limit &&
          fresh(get()._recentlyAddedFetchedAt, TTL_MS.recentlyAdded)
        )
          return
        return fetchValue(
          "recent",
          !!opts.force,
          limit,
          (provider) => provider.getRecentlyAdded(undefined, limit),
          (recentlyAdded) =>
            set({ recentlyAdded, _recentlyAddedFetchedAt: Date.now(), _recentlyAddedLimit: limit })
        )
      },
      fetchHubs: async (opts = {}) => {
        if (!opts.force && fresh(get()._hubsFetchedAt, TTL_MS.hubs)) return
        return fetchValue(
          "hubs",
          !!opts.force,
          0,
          (provider) => provider.getHubs(),
          (hubs) => set({ hubs: hubs.filter((hub) => hub.identifier), _hubsFetchedAt: Date.now() })
        )
      },
      fetchLikedTracks: async (limit = 500, opts = {}) => {
        if (
          !opts.force &&
          (get()._likedTracksLimit ?? 0) >= limit &&
          fresh(get()._likedTracksFetchedAt, TTL_MS.likedTracks)
        )
          return
        return fetchValue(
          "likedTracks",
          !!opts.force,
          limit,
          (provider) => provider.getLikedTracks(limit),
          (tracks) =>
            set({ likedTracks: rated(tracks), _likedTracksFetchedAt: Date.now(), _likedTracksLimit: limit })
        )
      },
      fetchLikedArtists: async (limit = 500, opts = {}) => {
        if (
          !opts.force &&
          (get()._likedArtistsLimit ?? 0) >= limit &&
          fresh(get()._likedArtistsFetchedAt, TTL_MS.likedArtists)
        )
          return
        return fetchValue(
          "likedArtists",
          !!opts.force,
          limit,
          (provider) => provider.getLikedArtists(limit),
          (likedArtists) =>
            set({ likedArtists, _likedArtistsFetchedAt: Date.now(), _likedArtistsLimit: limit })
        )
      },
      fetchLikedAlbums: async (limit = 500, opts = {}) => {
        if (
          !opts.force &&
          (get()._likedAlbumsLimit ?? 0) >= limit &&
          fresh(get()._likedAlbumsFetchedAt, TTL_MS.likedAlbums)
        )
          return
        return fetchValue(
          "likedAlbums",
          !!opts.force,
          limit,
          (provider) => provider.getLikedAlbums(limit),
          (likedAlbums) => set({ likedAlbums, _likedAlbumsFetchedAt: Date.now(), _likedAlbumsLimit: limit })
        )
      },
      fetchTags: async (opts = {}) => {
        if (!opts.force && fresh(get()._tagsFetchedAt, TTL_MS.tags)) return
        return fetchValue(
          "tags",
          !!opts.force,
          0,
          async (provider) =>
            provider.getTags
              ? Promise.allSettled([
                  provider.getTags("genre"),
                  provider.getTags("mood"),
                  provider.getTags("style")
                ])
              : [],
          (results) => {
            const patch: Partial<LibraryState> = {}
            for (let index = 0; index < results.length; index++) {
              const result = results[index]
              if (result.status === "fulfilled")
                patch[(["tagsGenre", "tagsMood", "tagsStyle"] as const)[index]] = [...result.value].sort(
                  (a, b) => a.tag.localeCompare(b.tag)
                )
              else patch.error = String(result.reason)
            }
            if (results.length === 3 && results.every((result) => result.status === "fulfilled"))
              patch._tagsFetchedAt = Date.now()
            set(patch)
          }
        )
      },
      addRecentMix: (seeds, tabType) => {
        if (!capture()) return
        const signature = (kind: string, ids: SeedItem[]) =>
          JSON.stringify([kind, ids.map((seed) => seed.id).sort()])
        const entry: RecentMix = { id: crypto.randomUUID(), createdAt: Date.now(), tabType, seeds }
        set((state) => ({
          recentMixes: [
            entry,
            ...state.recentMixes.filter(
              (mix) => signature(mix.tabType, mix.seeds) !== signature(tabType, seeds)
            )
          ].slice(0, 5)
        }))
      },
      fetchPlaylistItems: async (id) => {
        const session = capture(),
          selection = ++view
        if (!session) {
          set({
            currentPlaylist: null,
            currentPlaylistId: null,
            currentPlaylistItems: [],
            isLoading: false,
            isFetchingMore: false
          })
          return
        }
        const playlist = get().playlists.find((playlist) => playlist.id === id) ?? null
        const cached = get().playlistItemsCache[id]
        set({
          currentPlaylist: playlist,
          currentPlaylistId: id,
          currentPlaylistItems: cached ?? [],
          isLoading: !cached,
          isFetchingMore: false,
          error: null
        })
        if (cached) return
        const total = playlist?.trackCount ?? 0,
          limit = total > 0 && total <= SMALL_PLAYLIST_THRESHOLD ? total : INITIAL_PAGE_SIZE
        const valid = () => current(session) && view === selection && get().currentPlaylistId === id
        try {
          await firstPage(session, id, limit, total)
          if (valid()) set({ currentPlaylistItems: get().playlistItemsCache[id] ?? [], isLoading: false })
        } catch (error) {
          if (valid()) set({ error: String(error), isLoading: false })
        }
      },
      fetchMorePlaylistItems: async (id) => {
        const session = capture(),
          selection = view,
          revision = version(id)
        if (
          !session ||
          get().currentPlaylistId !== id ||
          get().isLoading ||
          get().isFetchingMore ||
          get().playlistIsFullyLoaded[id]
        )
          return
        const previous = get().playlistItemsCache[id] ?? [],
          request = Symbol(id)
        moreRequests.set(id, request)
        set({ isFetchingMore: true })
        const valid = () => current(session) && version(id) === revision && moreRequests.get(id) === request
        const visible = () => view === selection && get().currentPlaylistId === id
        try {
          const result = await session.provider.getPlaylistItems(id, previous.length, PAGE_SIZE)
          if (!valid() || get().playlistItemsCache[id] !== previous) return
          const items = rated([...previous, ...result.items]),
            total = get().playlists.find((playlist) => playlist.id === id)?.trackCount ?? 0
          const complete =
            result.items.length === 0 || (total > 0 ? items.length >= total : result.items.length < PAGE_SIZE)
          set((state) => ({
            playlistItemsCache: { ...state.playlistItemsCache, [id]: items },
            playlistIsFullyLoaded: { ...state.playlistIsFullyLoaded, [id]: complete },
            ...(get().currentPlaylistId === id ? { currentPlaylistItems: items } : {})
          }))
        } catch (error) {
          if (valid() && visible()) set({ error: String(error) })
        } finally {
          if (valid()) {
            moreRequests.delete(id)
            if (visible()) set({ isFetchingMore: false })
          }
        }
      },
      prefetchAllPlaylists: async () => {
        const session = capture()
        if (!session) return
        if (playlistPrefetch) return playlistPrefetch
        const toFetch = get()
          .playlists.filter(
            (playlist) => playlist.trackCount <= PREFETCH_THRESHOLD && !get().playlistItemsCache[playlist.id]
          )
          .sort((a, b) => a.trackCount - b.trackCount)
        if (!toFetch.length) return
        const work = (async () => {
          set({ prefetchStatus: { done: 0, total: toFetch.length } })
          for (let i = 0; i < toFetch.length; i++) {
            if (!current(session)) return
            const playlist = toFetch[i]
            if (!get().playlistItemsCache[playlist.id]) {
              try {
                await firstPage(
                  session,
                  playlist.id,
                  playlist.trackCount || INITIAL_PAGE_SIZE,
                  playlist.trackCount
                )
              } catch {
                /* Continue other playlists. */
              }
            }
            if (!current(session)) return
            set({ prefetchStatus: { done: i + 1, total: toFetch.length } })
            if (i < toFetch.length - 1) await delay(PREFETCH_DELAY_MS)
          }
          if (current(session)) set({ prefetchStatus: null })
        })().finally(() => {
          if (playlistPrefetch === work) playlistPrefetch = null
        })
        playlistPrefetch = work
        return work
      },
      prefetchMixTracks: async () => {
        const session = capture()
        if (!session?.provider.getMixTracks) return
        if (mixPrefetch) return mixPrefetch
        const keys = [
          ...new Set(
            get()
              .hubs.filter((hub) => hub.identifier?.startsWith("music.mixes"))
              .flatMap((hub) => hub.items)
              .filter((item) => item.type === "playlist")
              .map((item) => item.providerKey)
              .filter((key): key is string => !!key)
          )
        ]
        const work = (async () => {
          for (let i = 0; i < keys.length; i++) {
            if (!current(session)) return
            const key = keys[i]
            if (!get().mixTracksCache[key]) {
              try {
                const tracks = await session.provider.getMixTracks!(key)
                if (!current(session)) return
                set((state) => ({ mixTracksCache: { ...state.mixTracksCache, [key]: rated(tracks) } }))
              } catch {
                /* Continue other mixes. */
              }
            }
            if (!current(session)) return
            if (i < keys.length - 1) await delay(PREFETCH_DELAY_MS)
          }
        })().finally(() => {
          if (mixPrefetch === work) mixPrefetch = null
        })
        mixPrefetch = work
        return work
      },
      createPlaylist: async (title) => {
        const session = capture()
        if (!session) throw new Error("No provider")
        const playlist = await session.provider.createPlaylist(title, [])
        if (!current(session)) throw new Error("Library connection changed before the playlist was returned")
        requests.delete("playlists")
        set((state) => ({ playlists: [...state.playlists, playlist], _playlistsFetchedAt: null }))
        return playlist
      },
      refreshAll: async () => {
        await Promise.all([
          get().fetchPlaylists({ force: true }),
          get().fetchRecentlyAdded(50, { force: true }),
          get().fetchHubs({ force: true })
        ])
      },
      invalidatePlaylistItems: (id) => {
        bumpPlaylist(id)
        const { [id]: _items, ...items } = get().playlistItemsCache,
          { [id]: _loaded, ...loaded } = get().playlistIsFullyLoaded
        set({ playlistItemsCache: items, playlistIsFullyLoaded: loaded })
        if (get().currentPlaylistId === id) void get().fetchPlaylistItems(id)
      },
      removePlaylist: (id) => {
        bumpPlaylist(id)
        requests.delete("playlists")
        const { [id]: _items, ...items } = get().playlistItemsCache,
          { [id]: _loaded, ...loaded } = get().playlistIsFullyLoaded
        if (get().currentPlaylistId === id) view++
        set({
          playlists: get().playlists.filter((playlist) => playlist.id !== id),
          playlistItemsCache: items,
          playlistIsFullyLoaded: loaded,
          ...(get().currentPlaylistId === id
            ? {
                currentPlaylist: null,
                currentPlaylistItems: [],
                currentPlaylistId: null,
                isLoading: false,
                isFetchingMore: false
              }
            : {})
        })
      },
      renamePlaylist: (id, title) => {
        requests.delete("playlists")
        set({
          playlists: get().playlists.map((playlist) =>
            playlist.id === id ? { ...playlist, title } : playlist
          ),
          currentPlaylist:
            get().currentPlaylist?.id === id ? { ...get().currentPlaylist!, title } : get().currentPlaylist
        })
      },
      reorderPlaylistItems: (id, from, to) => {
        const source =
          get().playlistItemsCache[id] ?? (get().currentPlaylistId === id ? get().currentPlaylistItems : [])
        if (from < 0 || from >= source.length || to < 0 || to >= source.length) return
        bumpPlaylist(id)
        const items = [...source],
          [moved] = items.splice(from, 1)
        items.splice(to, 0, moved)
        set((state) => ({
          playlistItemsCache: { ...state.playlistItemsCache, [id]: items },
          ...(state.currentPlaylistId === id ? { currentPlaylistItems: items, isFetchingMore: false } : {})
        }))
      },
      onItemRated: (id: string, itemType: "track" | "album" | "artist", newRating: number | null) => {
        requests.delete(
          `liked${itemType === "track" ? "Tracks" : itemType === "album" ? "Albums" : "Artists"}`
        )
        if (itemType === "track") {
          ratings.set(id, newRating)
          if (ratings.size > 500) ratings.delete(ratings.keys().next().value!)
          // Invalidate liked tracks TTL so next visit re-fetches
          set({ _likedTracksFetchedAt: null })
          // Update rating in likedTracks list
          set({
            likedTracks: get().likedTracks.map((t) => (t.id === id ? { ...t, userRating: newRating } : t))
          })
          // Update rating in playlist item caches
          const cache = get().playlistItemsCache
          const updated: Record<string, MusicTrack[]> = {}
          for (const [pid, tracks] of Object.entries(cache)) {
            const changed = tracks.some((t) => t.id === id)
            if (changed) {
              updated[pid] = tracks.map((t) => (t.id === id ? { ...t, userRating: newRating } : t))
            }
          }
          if (Object.keys(updated).length > 0) {
            set({ playlistItemsCache: { ...cache, ...updated } })
            // Also update current playlist items if affected
            const { currentPlaylistId, currentPlaylistItems } = get()
            if (currentPlaylistId && updated[currentPlaylistId]) {
              set({ currentPlaylistItems: updated[currentPlaylistId] })
            } else if (currentPlaylistItems.some((t) => t.id === id)) {
              set({
                currentPlaylistItems: currentPlaylistItems.map((t) =>
                  t.id === id ? { ...t, userRating: newRating } : t
                )
              })
            }
          }
        } else if (itemType === "album") {
          set({ _likedAlbumsFetchedAt: null })
          set({
            likedAlbums: get().likedAlbums.map((a) => (a.id === id ? { ...a, userRating: newRating } : a))
          })
        } else if (itemType === "artist") {
          set({ _likedArtistsFetchedAt: null })
          set({
            likedArtists: get().likedArtists.map((a) => (a.id === id ? { ...a, userRating: newRating } : a))
          })
        }
      },

      invalidateCache: () => {
        cache.cancelHydration()
        retire()
        set({
          _playlistsFetchedAt: null,
          _recentlyAddedFetchedAt: null,
          _recentlyAddedLimit: undefined,
          _hubsFetchedAt: null,
          _likedTracksFetchedAt: null,
          _likedTracksLimit: undefined,
          _likedArtistsFetchedAt: null,
          _likedArtistsLimit: undefined,
          _likedAlbumsFetchedAt: null,
          _likedAlbumsLimit: undefined,
          _tagsFetchedAt: null,
          playlistItemsCache: {},
          playlistIsFullyLoaded: {},
          mixTracksCache: {},
          prefetchStatus: null,
          isLoading: false,
          isFetchingMore: false
        })
        if (get().currentPlaylistId) void get().fetchPlaylistItems(get().currentPlaylistId!)
      },
      invalidateLibraryTTLs: () => {
        for (const key of ["playlists", "recent", "hubs"]) requests.delete(key)
        set({ _playlistsFetchedAt: null, _recentlyAddedFetchedAt: null, _hubsFetchedAt: null })
      },
      clearAll: () => {
        void cache.activate(null)
        retire()
        activeProvider = null
        set(emptyLibrary())
      }
    }
  })
  store.subscribe((state) =>
    cache.save(Object.fromEntries(persistedFields.map((field) => [field, state[field]])))
  )
  return store
}

export const useLibraryStore = createLibraryStore({
  getProvider: () => useProviderStore.getState().provider,
  storage: idbStorage
})
