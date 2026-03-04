/**
 * Persistent metadata cache for artist and album pages.
 *
 * Zustand store with `persist` middleware — survives app restarts via IndexedDB.
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
import { idbJSONStorage } from "./idbStorage"
import { useProviderStore } from "./providerStore"
import type { MusicArtist, MusicAlbum, MusicTrack, MusicHub, MusicPlaylist } from "../types/music"
import { processArtistAlbums } from "../lib/dedup"

// ---------------------------------------------------------------------------
// Cache entry types
// ---------------------------------------------------------------------------

export interface ArtistCacheEntry {
  artist: MusicArtist
  albums: MusicAlbum[]
  singles: MusicAlbum[]
  popularTracks: MusicTrack[]
  similarArtists: MusicArtist[]
  sonicallySimilar: MusicArtist[]
  relatedHubs: MusicHub[]
  stations: MusicPlaylist[]
  fetchedAt: number
}

export interface AlbumCacheEntry {
  album: MusicAlbum
  tracks: MusicTrack[]
  relatedHubs: MusicHub[]
  fetchedAt: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Data older than this is considered stale — still served, but re-fetched in background. */
const STALE_MS = 30 * 60_000 // 30 minutes

/** Entries older than this are evicted on write to keep the cache bounded. */
const EVICT_MS = 24 * 60 * 60_000 // 24 hours

const MAX_ARTISTS = 50
const MAX_ALBUMS = 100

// ---------------------------------------------------------------------------
// Inflight dedup (module-level, not persisted)
// ---------------------------------------------------------------------------

const artistInflight = new Set<string>()
const albumInflight = new Set<string>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProvider() {
  return useProviderStore.getState().provider
}

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
  record: Record<string, T>,
  maxEntries: number,
): Record<string, T> {
  const now = Date.now()
  const entries = Object.entries(record)
    .filter(([, v]) => now - v.fetchedAt < EVICT_MS)
    .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
    .slice(0, maxEntries)
  return Object.fromEntries(entries)
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface MetadataCacheState {
  artists: Record<string, ArtistCacheEntry>
  albums: Record<string, AlbumCacheEntry>

  setArtistCache: (id: string, entry: Omit<ArtistCacheEntry, "fetchedAt">) => void
  setAlbumCache: (id: string, entry: Omit<AlbumCacheEntry, "fetchedAt">) => void
}

const useMetadataCacheStore = create<MetadataCacheState>()(persist((set) => ({
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
  storage: idbJSONStorage,
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

export function getCachedArtist(id: string): ArtistCacheEntry | undefined {
  return useMetadataCacheStore.getState().artists[id]
}

export function getCachedAlbum(id: string): AlbumCacheEntry | undefined {
  return useMetadataCacheStore.getState().albums[id]
}

export function setArtistCache(id: string, entry: Omit<ArtistCacheEntry, "fetchedAt">): void {
  useMetadataCacheStore.getState().setArtistCache(id, entry)
}

export function setAlbumCache(id: string, entry: Omit<AlbumCacheEntry, "fetchedAt">): void {
  useMetadataCacheStore.getState().setAlbumCache(id, entry)
}

/**
 * Fire-and-forget: pre-fetch ALL data the artist page needs.
 * Includes popular tracks, similar artists, hubs, stations — everything.
 */
export function prefetchArtist(id: string): void {
  if (artistInflight.has(id)) return
  const existing = useMetadataCacheStore.getState().artists[id]
  if (existing && !isStale(existing.fetchedAt)) return

  const provider = getProvider()
  if (!provider) return

  artistInflight.add(id)

  Promise.all([
    provider.getArtist(id),
    provider.getArtistAlbumsInSection ? provider.getArtistAlbumsInSection(id) : provider.getArtistAlbums(id),
    provider.getArtistAlbumsInSection ? provider.getArtistAlbumsInSection(id, "EP,Single") : Promise.resolve([] as MusicAlbum[]),
    provider.getArtistPopularTracksInSection ? provider.getArtistPopularTracksInSection(id, 15) : provider.getArtistPopularTracks(id, 15),
    provider.getArtistSimilar(id).catch(() => [] as MusicArtist[]),
    provider.getArtistSonicallySimilar ? provider.getArtistSonicallySimilar(id, 20).catch(() => [] as MusicArtist[]) : Promise.resolve([] as MusicArtist[]),
    provider.getRelatedHubs(id).catch(() => [] as MusicHub[]),
    provider.getArtistStations ? provider.getArtistStations(id).catch(() => [] as MusicPlaylist[]) : Promise.resolve([] as MusicPlaylist[]),
  ])
    .then(([artist, allAlbums, singleList, tracks, sim, sonic, hubs, stations]) => {
      const { albums, singles } = processArtistAlbums(allAlbums, singleList, true)

      useMetadataCacheStore.getState().setArtistCache(id, {
        artist,
        albums,
        singles,
        popularTracks: dedupeBy(tracks, (t: MusicTrack) => t.id),
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
export function prefetchAlbum(id: string): void {
  if (albumInflight.has(id)) return
  const existing = useMetadataCacheStore.getState().albums[id]
  if (existing && !isStale(existing.fetchedAt)) return

  const provider = getProvider()
  if (!provider) return

  albumInflight.add(id)

  Promise.all([
    provider.getAlbum(id),
    provider.getAlbumTracks(id),
    provider.getRelatedHubs(id).catch(() => [] as MusicHub[]),
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
