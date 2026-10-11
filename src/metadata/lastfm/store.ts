/**
 * Last.fm metadata cache — persisted to IndexedDB via Zustand persist.
 *
 * Rust fetches data from Last.fm on demand; this store caches the results
 * client-side with TTL to avoid redundant API calls.
 *
 * TTLs:
 *   - artist / album : 7 days  (biographical data changes infrequently)
 *   - track          : 3 days  (play counts update more often)
 *
 * Naming conventions for cache keys:
 *   - artists : lowercase artist name
 *   - albums  : `${artist.toLowerCase()}::${album.toLowerCase()}`
 *   - tracks  : `${artist.toLowerCase()}::${track.toLowerCase()}`
 */

import { create } from "zustand"
import {
  lastfmGetAlbumInfo,
  lastfmGetArtistInfo,
  lastfmGetTrackInfo,
  type LastfmAlbumInfo,
  type LastfmArtistInfo,
  type LastfmTrackInfo,
} from "./api"
import { safePersist } from "../../stores/idbStorage"
import { evictStaleEntries } from "../../stores/cacheUtils"
import { useLastfmStore } from "./authStore"

// ---------------------------------------------------------------------------
// TTLs
// ---------------------------------------------------------------------------

const ARTIST_ALBUM_TTL_MS = 7 * 24 * 60 * 60_000  // 7 days
const TRACK_TTL_MS = 3 * 24 * 60 * 60_000          // 3 days

// In-flight dedup: if the same key is requested before the first response
// arrives, return the existing promise instead of starting a new Tauri invoke.
const inflightArtists = new Map<string, Promise<LastfmArtistInfo | null>>()
const inflightAlbums  = new Map<string, Promise<LastfmAlbumInfo | null>>()
const inflightTracks  = new Map<string, Promise<LastfmTrackInfo | null>>()

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T
  cachedAt: number  // Date.now() timestamp
}

interface LastfmMetadataState {
  artists: Record<string, CacheEntry<LastfmArtistInfo>>
  albums:  Record<string, CacheEntry<LastfmAlbumInfo>>
  tracks:  Record<string, CacheEntry<LastfmTrackInfo>>

  /** True once IndexedDB hydration has completed. Hooks should wait for this before fetching. */
  _hasHydrated: boolean

  getArtist: (artist: string) => Promise<LastfmArtistInfo | null>
  getAlbum: (artist: string, album: string) => Promise<LastfmAlbumInfo | null>
  getTrack: (artist: string, track: string) => Promise<LastfmTrackInfo | null>

  /** Clear all cached metadata (resets artists, albums, tracks). */
  clearCache: () => void

  /** Computed stats — count of cached entries per category. */
  stats: () => { artistCount: number; albumCount: number; trackCount: number }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useLastfmMetadataStore = create<LastfmMetadataState>()(
  safePersist(
    (set, get) => ({
      artists: {},
      albums: {},
      tracks: {},
      _hasHydrated: false,

      getArtist: async (artist) => {
        if (!useLastfmStore.getState().hasApiKey) return null
        const key = artist.toLowerCase()
        const cached = get().artists[key]
        if (cached && Date.now() - cached.cachedAt < ARTIST_ALBUM_TTL_MS) return cached.data
        const existing = inflightArtists.get(key)
        if (existing) return existing
        const promise = (async () => {
          try {
            const data = await lastfmGetArtistInfo(artist)
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
        if (!useLastfmStore.getState().hasApiKey) return null
        const key = `${artist.toLowerCase()}::${album.toLowerCase()}`
        const cached = get().albums[key]
        if (cached && Date.now() - cached.cachedAt < ARTIST_ALBUM_TTL_MS) return cached.data
        const existing = inflightAlbums.get(key)
        if (existing) return existing
        const promise = (async () => {
          try {
            const data = await lastfmGetAlbumInfo(artist, album)
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

      getTrack: async (artist, track) => {
        if (!useLastfmStore.getState().hasApiKey) return null
        const key = `${artist.toLowerCase()}::${track.toLowerCase()}`
        const cached = get().tracks[key]
        if (cached && Date.now() - cached.cachedAt < TRACK_TTL_MS) return cached.data
        const existing = inflightTracks.get(key)
        if (existing) return existing
        const promise = (async () => {
          try {
            const data = await lastfmGetTrackInfo(artist, track)
            set((s) => ({ tracks: { ...s.tracks, [key]: { data, cachedAt: Date.now() } } }))
            return data
          } catch {
            return null
          } finally {
            inflightTracks.delete(key)
          }
        })()
        inflightTracks.set(key, promise)
        return promise
      },

      clearCache: () => {
        set({ artists: {}, albums: {}, tracks: {} })
        useLastfmMetadataStore.persist.clearStorage()
      },

      stats: () => {
        const { artists, albums, tracks } = get()
        return {
          artistCount: Object.keys(artists).length,
          albumCount: Object.keys(albums).length,
          trackCount: Object.keys(tracks).length,
        }
      },
    }),
    {
      name: "lastfm-metadata-v1",
      partialize: (s) => ({
        artists: s.artists,
        albums: s.albums,
        tracks: s.tracks,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.artists = evictStaleEntries(state.artists)
          state.albums = evictStaleEntries(state.albums)
          state.tracks = evictStaleEntries(state.tracks)
        }
        useLastfmMetadataStore.setState({ _hasHydrated: true })
      },
    },
  ),
)
