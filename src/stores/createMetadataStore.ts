import { create } from "zustand"
import { safePersist } from "./idbStorage"
import { evictStaleEntries } from "./cacheUtils"

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000 // 7 days

export interface CacheEntry<T> {
  data: T | null
  cachedAt: number
}

export interface MetadataStoreState<ArtistT, AlbumT> {
  artists: Record<string, CacheEntry<ArtistT>>
  albums: Record<string, CacheEntry<AlbumT>>
  _hasHydrated: boolean
  _loadingArtists: Record<string, true>
  _loadingAlbums: Record<string, true>
  getArtist: (artist: string) => Promise<ArtistT | null>
  getAlbum: (artist: string, album: string) => Promise<AlbumT | null>
  invalidateArtist: (artist: string) => void
  invalidateAlbum: (artist: string, album: string) => void
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
  const artistVersions = new Map<string, number>()
  const albumVersions = new Map<string, number>()
  let epoch = 0

  const store = create<MetadataStoreState<ArtistT, AlbumT>>()(
    safePersist(
      (set, get) => ({
        artists: {},
        albums: {},
        _hasHydrated: false,
        _loadingArtists: {},
        _loadingAlbums: {},

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
          const generation = artistVersions.get(key) ?? 0,
            requestEpoch = epoch
          set((s) => ({
            _loadingArtists: { ...s._loadingArtists, [key]: true },
          }))
          const promise = (async () => {
            try {
              const data = await fetchArtist(artist)
              if (
                requestEpoch !== epoch ||
                generation !== (artistVersions.get(key) ?? 0)
              )
                return null
              set((s) => ({
                artists: {
                  ...s.artists,
                  [key]: { data, cachedAt: Date.now() },
                },
              }))
              return data
            } catch {
              return null
            } finally {
              if (
                requestEpoch === epoch &&
                generation === (artistVersions.get(key) ?? 0)
              ) {
                inflightArtists.delete(key)
                set((s) => {
                  const { [key]: _done, ...pending } = s._loadingArtists
                  return { _loadingArtists: pending }
                })
              }
            }
          })()
          inflightArtists.set(key, promise)
          return promise
        },

        getAlbum: async (artist, album) => {
          if (guard && !guard()) return null
          const key = `${artist.toLowerCase()}::${album.toLowerCase()}`
          const cached = get().albums[key]
          if (
            cached &&
            cached.data !== null &&
            validateAlbum &&
            !validateAlbum(cached.data, artist, album)
          ) {
            // Retire only this unrelated legacy positive, leaving every other
            // cached artist/album and its original TTL intact.
            set((state) => {
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
            return data !== null &&
              validateAlbum &&
              !validateAlbum(data, artist, album)
              ? null
              : data
          }
          const generation = albumVersions.get(key) ?? 0,
            requestEpoch = epoch
          set((s) => ({ _loadingAlbums: { ...s._loadingAlbums, [key]: true } }))
          const promise = (async () => {
            try {
              const fetched = await fetchAlbum(artist, album)
              if (
                requestEpoch !== epoch ||
                generation !== (albumVersions.get(key) ?? 0)
              )
                return null
              // An unrelated positive is not evidence that this album is
              // absent. Reject it without creating a long-lived negative TTL.
              if (
                fetched !== null &&
                validateAlbum &&
                !validateAlbum(fetched, artist, album)
              )
                return null
              const data = fetched
              set((s) => ({
                albums: { ...s.albums, [key]: { data, cachedAt: Date.now() } },
              }))
              return data
            } catch {
              return null
            } finally {
              if (
                requestEpoch === epoch &&
                generation === (albumVersions.get(key) ?? 0)
              ) {
                inflightAlbums.delete(key)
                set((s) => {
                  const { [key]: _done, ...pending } = s._loadingAlbums
                  return { _loadingAlbums: pending }
                })
              }
            }
          })()
          inflightAlbums.set(key, promise)
          return promise
        },

        invalidateArtist: (artist) => {
          const key = artist.toLowerCase()
          artistVersions.set(key, (artistVersions.get(key) ?? 0) + 1)
          inflightArtists.delete(key)
          set((s) => {
            const { [key]: _old, ...artists } = s.artists
            const { [key]: _pending, ...pending } = s._loadingArtists
            return { artists, _loadingArtists: pending }
          })
        },
        invalidateAlbum: (artist, album) => {
          const key = `${artist.toLowerCase()}::${album.toLowerCase()}`
          albumVersions.set(key, (albumVersions.get(key) ?? 0) + 1)
          inflightAlbums.delete(key)
          set((s) => {
            const { [key]: _old, ...albums } = s.albums
            const { [key]: _pending, ...pending } = s._loadingAlbums
            return { albums, _loadingAlbums: pending }
          })
        },
        clearCache: () => {
          epoch++
          inflightArtists.clear()
          inflightAlbums.clear()
          artistVersions.clear()
          albumVersions.clear()
          set({
            artists: {},
            albums: {},
            _loadingArtists: {},
            _loadingAlbums: {},
            _hasHydrated: true,
          })
          store.persist.clearStorage()
        },

        stats: () => {
          const { artists, albums } = get()
          return {
            artistCount: Object.keys(artists).length,
            albumCount: Object.keys(albums).length,
          }
        },
      }),
      {
        name: storeName,
        partialize: (s) => ({ artists: s.artists, albums: s.albums }),
        onRehydrateStorage: () => (state) => {
          if (state) {
            state.artists = evictStaleEntries(state.artists, evictionTtl)
            state.albums = evictStaleEntries(state.albums, evictionTtl)
            if (validateCachedAlbum)
              state.albums = Object.fromEntries(
                Object.entries(state.albums).filter(
                  ([key, entry]) =>
                    entry.data === null || validateCachedAlbum(entry.data, key)
                )
              )
          }
          store.setState({ _hasHydrated: true })
        },
      }
    )
  )

  return store
}
