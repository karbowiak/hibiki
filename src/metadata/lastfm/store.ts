/**
 * Last.fm metadata cache — persisted to SQLite via Zustand persist.
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
import { safePersist } from "../../stores/sqliteStorage"
import { evictStaleEntries } from "../../stores/cacheUtils"
import { CacheRequests } from "../../lib/cacheRequests"
import { useLastfmStore } from "./authStore"

// ---------------------------------------------------------------------------
// TTLs
// ---------------------------------------------------------------------------

const ARTIST_ALBUM_TTL_MS = 7 * 24 * 60 * 60_000 // 7 days
const TRACK_TTL_MS = 3 * 24 * 60 * 60_000 // 3 days

const requests = new CacheRequests()
const limits = { artists: 500, albums: 1000, tracks: 2000 }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T
  cachedAt: number // Date.now() timestamp
}

interface LastfmMetadataState {
  artists: Record<string, CacheEntry<LastfmArtistInfo>>
  albums: Record<string, CacheEntry<LastfmAlbumInfo>>
  tracks: Record<string, CacheEntry<LastfmTrackInfo>>

  /** True once SQLite hydration has completed. Hooks should wait for this before fetching. */
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
        if (cached && Date.now() - cached.cachedAt < ARTIST_ALBUM_TTL_MS)
          return cached.data
        return requests.load(
          `artists:${key}`,
          () => lastfmGetArtistInfo(artist),
          (data) => {
            set((state) => ({
              artists: evictStaleEntries(
                { ...state.artists, [key]: { data, cachedAt: Date.now() } },
                ARTIST_ALBUM_TTL_MS * 1.5,
                limits.artists,
                key
              ),
            }))
          }
        )
      },

      getAlbum: async (artist, album) => {
        if (!useLastfmStore.getState().hasApiKey) return null
        const key = `${artist.toLowerCase()}::${album.toLowerCase()}`
        const cached = get().albums[key]
        if (cached && Date.now() - cached.cachedAt < ARTIST_ALBUM_TTL_MS)
          return cached.data
        return requests.load(
          `albums:${key}`,
          () => lastfmGetAlbumInfo(artist, album),
          (data) => {
            set((state) => ({
              albums: evictStaleEntries(
                { ...state.albums, [key]: { data, cachedAt: Date.now() } },
                ARTIST_ALBUM_TTL_MS * 1.5,
                limits.albums,
                key
              ),
            }))
          }
        )
      },

      getTrack: async (artist, track) => {
        if (!useLastfmStore.getState().hasApiKey) return null
        const key = `${artist.toLowerCase()}::${track.toLowerCase()}`
        const cached = get().tracks[key]
        if (cached && Date.now() - cached.cachedAt < TRACK_TTL_MS)
          return cached.data
        return requests.load(
          `tracks:${key}`,
          () => lastfmGetTrackInfo(artist, track),
          (data) => {
            set((state) => ({
              tracks: evictStaleEntries(
                { ...state.tracks, [key]: { data, cachedAt: Date.now() } },
                TRACK_TTL_MS * 1.5,
                limits.tracks,
                key
              ),
            }))
          }
        )
      },

      clearCache: () => {
        requests.clear()
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
          state.artists = evictStaleEntries(
            state.artists,
            ARTIST_ALBUM_TTL_MS * 1.5,
            limits.artists
          )
          state.albums = evictStaleEntries(
            state.albums,
            ARTIST_ALBUM_TTL_MS * 1.5,
            limits.albums
          )
          state.tracks = evictStaleEntries(
            state.tracks,
            TRACK_TTL_MS * 1.5,
            limits.tracks
          )
        }
        useLastfmMetadataStore.setState({ _hasHydrated: true })
      },
    }
  )
)
