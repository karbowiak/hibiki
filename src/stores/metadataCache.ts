/**
 * Persistent metadata cache for artist and album pages.
 *
 * Zustand store with `persist` middleware — survives app restarts via localStorage.
 * Hover-prefetch (`prefetchArtist`/`prefetchAlbum`) loads ALL data a page needs
 * so navigation always renders instantly from cache with zero layout shift.
 *
 * Usage:
 *   - Call prefetchArtist/prefetchAlbum on hover (fire-and-forget).
 *   - Read getCachedArtist/getCachedAlbum at the top of the page component.
 *   - After a page's full fetch completes, call setArtistCache/setAlbumCache
 *     to update the persistent cache.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  getArtist,
  getArtistAlbumsInSection,
  getArtistPopularTracksInSection,
  getArtistSimilar,
  getArtistSonicallySimilar,
  getRelatedHubs,
  getArtistStations,
  getAlbum,
  getAlbumTracks,
} from "../lib/plex"
import type { Artist, Album, Track, Hub, Playlist } from "../types/plex"

// ---------------------------------------------------------------------------
// Cache entry types
// ---------------------------------------------------------------------------

export interface ArtistCacheEntry {
  artist: Artist
  albums: Album[]
  singles: Album[]
  popularTracks: Track[]
  similarArtists: Artist[]
  sonicallySimilar: Artist[]
  relatedHubs: Hub[]
  stations: Playlist[]
  fetchedAt: number
}

export interface AlbumCacheEntry {
  album: Album
  tracks: Track[]
  relatedHubs: Hub[]
  fetchedAt: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Data older than this is considered stale — still served, but re-fetched in background. */
const STALE_MS = 30 * 60_000 // 30 minutes

/** Entries older than this are evicted on write to keep localStorage bounded. */
const EVICT_MS = 24 * 60 * 60_000 // 24 hours

const MAX_ARTISTS = 50
const MAX_ALBUMS = 100

// ---------------------------------------------------------------------------
// Inflight dedup (module-level, not persisted)
// ---------------------------------------------------------------------------

const artistInflight = new Set<number>()
const albumInflight = new Set<number>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dedupeBy<T>(items: T[], key: (item: T) => unknown): T[] {
  const seen = new Set()
  return items.filter(item => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function evictRecord<T extends { fetchedAt: number }>(
  record: Record<number, T>,
  maxEntries: number,
): Record<number, T> {
  const now = Date.now()
  const entries = Object.entries(record)
    .map(([k, v]) => [Number(k), v] as [number, T])
    .filter(([, v]) => now - v.fetchedAt < EVICT_MS)
    .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
    .slice(0, maxEntries)
  return Object.fromEntries(entries)
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface MetadataCacheState {
  artists: Record<number, ArtistCacheEntry>
  albums: Record<number, AlbumCacheEntry>

  setArtistCache: (id: number, entry: Omit<ArtistCacheEntry, "fetchedAt">) => void
  setAlbumCache: (id: number, entry: Omit<AlbumCacheEntry, "fetchedAt">) => void
}

const useMetadataCacheStore = create<MetadataCacheState>()(persist((set, get) => ({
  artists: {},
  albums: {},

  setArtistCache: (id, entry) => set(state => {
    const updated = { ...state.artists, [id]: { ...entry, fetchedAt: Date.now() } }
    return { artists: evictRecord(updated, MAX_ARTISTS) }
  }),

  setAlbumCache: (id, entry) => set(state => {
    const updated = { ...state.albums, [id]: { ...entry, fetchedAt: Date.now() } }
    return { albums: evictRecord(updated, MAX_ALBUMS) }
  }),
}), {
  name: "plex-metadata-cache-v1",
  partialize: (state) => ({
    artists: state.artists,
    albums: state.albums,
  }),
}))

// ---------------------------------------------------------------------------
// Public API — standalone functions for backward compatibility
// ---------------------------------------------------------------------------

function isStale(fetchedAt: number): boolean {
  return Date.now() - fetchedAt > STALE_MS
}

export function getCachedArtist(id: number): ArtistCacheEntry | undefined {
  return useMetadataCacheStore.getState().artists[id]
}

export function getCachedAlbum(id: number): AlbumCacheEntry | undefined {
  return useMetadataCacheStore.getState().albums[id]
}

export function setArtistCache(id: number, entry: Omit<ArtistCacheEntry, "fetchedAt">): void {
  useMetadataCacheStore.getState().setArtistCache(id, entry)
}

export function setAlbumCache(id: number, entry: Omit<AlbumCacheEntry, "fetchedAt">): void {
  useMetadataCacheStore.getState().setAlbumCache(id, entry)
}

/**
 * Fire-and-forget: pre-fetch ALL data the artist page needs.
 * Includes popular tracks, similar artists, hubs, stations — everything.
 */
export function prefetchArtist(id: number, sectionId: number): void {
  if (artistInflight.has(id)) return
  const existing = useMetadataCacheStore.getState().artists[id]
  if (existing && !isStale(existing.fetchedAt)) return

  artistInflight.add(id)

  Promise.all([
    getArtist(id),
    getArtistAlbumsInSection(sectionId, id).catch(() => [] as Album[]),
    getArtistAlbumsInSection(sectionId, id, "EP,Single").catch(() => [] as Album[]),
    getArtistPopularTracksInSection(sectionId, id, 15).catch(() => [] as Track[]),
    getArtistSimilar(id).catch(() => [] as Artist[]),
    getArtistSonicallySimilar(id, 20).catch(() => [] as Artist[]),
    getRelatedHubs(id, 20).catch(() => [] as Hub[]),
    getArtistStations(id).catch(() => [] as Playlist[]),
  ])
    .then(([artist, allAlbums, singleList, tracks, sim, sonic, hubs, stations]) => {
      const dedupedSingles = dedupeBy(singleList, (a: Album) => a.rating_key)
      const singleKeys = new Set(dedupedSingles.map((s: Album) => s.rating_key))
      const albums = dedupeBy(allAlbums, (a: Album) => a.rating_key)
        .filter((a: Album) => !singleKeys.has(a.rating_key))

      useMetadataCacheStore.getState().setArtistCache(id, {
        artist,
        albums,
        singles: dedupedSingles,
        popularTracks: dedupeBy(tracks, (t: Track) => t.rating_key),
        similarArtists: sim,
        sonicallySimilar: sonic,
        relatedHubs: hubs,
        stations,
      })
    })
    .catch(() => {})
    .finally(() => artistInflight.delete(id))
}

/**
 * Fire-and-forget: pre-fetch ALL data the album page needs.
 * Includes tracks and related hubs.
 */
export function prefetchAlbum(id: number): void {
  if (albumInflight.has(id)) return
  const existing = useMetadataCacheStore.getState().albums[id]
  if (existing && !isStale(existing.fetchedAt)) return

  albumInflight.add(id)

  Promise.all([
    getAlbum(id),
    getAlbumTracks(id),
    getRelatedHubs(id, 20).catch(() => [] as Hub[]),
  ])
    .then(([album, tracks, hubs]) => {
      useMetadataCacheStore.getState().setAlbumCache(id, {
        album,
        tracks,
        relatedHubs: hubs,
      })
    })
    .catch(() => {})
    .finally(() => albumInflight.delete(id))
}
