import { create } from "zustand"
import { safePersist } from "./idbStorage"
import { evictStaleEntries } from "./cacheUtils"

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000  // 7 days

export interface CacheEntry<T> {
  data: T | null
  cachedAt: number
}

export interface MetadataStoreState<ArtistT, AlbumT> {
  artists: Record<string, CacheEntry<ArtistT>>
  albums: Record<string, CacheEntry<AlbumT>>
  _hasHydrated: boolean
  getArtist: (artist: string) => Promise<ArtistT | null>
  getAlbum: (artist: string, album: string) => Promise<AlbumT | null>
  clearCache: () => void
  stats: () => { artistCount: number; albumCount: number }
}

interface CreateMetadataStoreOpts<ArtistT, AlbumT> {
  storeName: string
  fetchArtist: (artist: string) => Promise<ArtistT | null>
  fetchAlbum: (artist: string, album: string) => Promise<AlbumT | null>
  artistTtl?: number
  albumTtl?: number
  negativeTtl?: number
  evictionTtl?: number
  guard?: () => boolean
  validateAlbum?: (data: AlbumT, artist: string, album: string) => boolean
  validateCachedAlbum?: (data: AlbumT, key: string) => boolean
}

export function createMetadataStore<ArtistT, AlbumT>(
  opts: CreateMetadataStoreOpts<ArtistT, AlbumT>
) {
  const {
    storeName,
    fetchArtist,
    fetchAlbum,
    artistTtl = DEFAULT_TTL_MS,
    albumTtl = DEFAULT_TTL_MS,
    negativeTtl = DEFAULT_TTL_MS,
    guard,
    validateAlbum,
    validateCachedAlbum,
  } = opts

  const evictionTtl = opts.evictionTtl ?? Math.max(artistTtl, albumTtl) * 1.5

  const inflightArtists = new Map<string, Promise<ArtistT | null>>()
  const inflightAlbums = new Map<string, Promise<AlbumT | null>>()

  const store = create<MetadataStoreState<ArtistT, AlbumT>>()(
    safePersist(
      (set, get) => ({
        artists: {},
        albums: {},
        _hasHydrated: false,

        getArtist: async (artist) => {
          if (guard && !guard()) return null
          const key = artist.toLowerCase()
          const cached = get().artists[key]
          if (cached) {
            const ttl = cached.data === null ? negativeTtl : artistTtl
            if (Date.now() - cached.cachedAt < ttl) return cached.data
          }
          const existing = inflightArtists.get(key)
          if (existing) return existing
          const promise = (async () => {
            try {
              const data = await fetchArtist(artist)
              set((s) => ({ artists: { ...s.artists, [key]: { data, cachedAt: Date.now() } } }))
              return data
            } catch {
              return null
            } finally {
              inflightArtists.delete(key)
            }
          })()
          inflightArtists.set(key, promise)
          return promise
        },

        getAlbum: async (artist, album) => {
          if (guard && !guard()) return null
          const key = `${artist.toLowerCase()}::${album.toLowerCase()}`
          const cached = get().albums[key]
          if (cached && cached.data !== null && validateAlbum && !validateAlbum(cached.data, artist, album)) {
            // Retire only this unrelated legacy positive, leaving every other
            // cached artist/album and its original TTL intact.
            set(state => {
              const { [key]: _unrelated, ...albums } = state.albums
              return { albums }
            })
          } else if (cached) {
            const ttl = cached.data === null ? negativeTtl : albumTtl
            if (Date.now() - cached.cachedAt < ttl) return cached.data
          }
          const existing = inflightAlbums.get(key)
          if (existing) {
            const data = await existing
            return data !== null && validateAlbum && !validateAlbum(data, artist, album) ? null : data
          }
          const promise = (async () => {
            try {
              const fetched = await fetchAlbum(artist, album)
              // An unrelated positive is not evidence that this album is
              // absent. Reject it without creating a long-lived negative TTL.
              if (fetched !== null && validateAlbum && !validateAlbum(fetched, artist, album)) return null
              const data = fetched
              set((s) => ({ albums: { ...s.albums, [key]: { data, cachedAt: Date.now() } } }))
              return data
            } catch {
              return null
            } finally {
              inflightAlbums.delete(key)
            }
          })()
          inflightAlbums.set(key, promise)
          return promise
        },

        clearCache: () => {
          set({ artists: {}, albums: {}, _hasHydrated: true })
          store.persist.clearStorage()
        },

        stats: () => {
          const { artists, albums } = get()
          return { artistCount: Object.keys(artists).length, albumCount: Object.keys(albums).length }
        },
      }),
      {
        name: storeName,
        partialize: (s) => ({ artists: s.artists, albums: s.albums }),
        onRehydrateStorage: () => (state) => {
          if (state) {
            state.artists = evictStaleEntries(state.artists, evictionTtl)
            state.albums = evictStaleEntries(state.albums, evictionTtl)
            if (validateCachedAlbum) state.albums = Object.fromEntries(
              Object.entries(state.albums).filter(([key, entry]) => entry.data === null || validateCachedAlbum(entry.data, key)))
          }
          store.setState({ _hasHydrated: true })
        },
      },
    ),
  )

  return store
}
