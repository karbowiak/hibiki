/**
 * MusicBrainz recording MBID cache — persisted to IndexedDB via Zustand persist.
 *
 * Caches recording MBIDs (+ associated artist/release/release-group MBIDs)
 * keyed by `artist::track::album`. Used by ListenBrainz to submit properly
 * matched listens even when Plex doesn't provide MBIDs.
 *
 * 30-day TTL — MBIDs are stable identifiers that rarely change.
 */

import { create } from "zustand"
import { safePersist } from "../../stores/idbStorage"
import { evictStaleEntries } from "../../stores/cacheUtils"
import { musicbrainzLookupRecording, type MusicBrainzRecordingMbids } from "./api"

const TTL_MS = 30 * 24 * 60 * 60_000 // 30 days
const EVICTION_TTL = TTL_MS * 1.5

interface CacheEntry {
  data: MusicBrainzRecordingMbids | null
  cachedAt: number
}

interface MbidStoreState {
  recordings: Record<string, CacheEntry>
  _hasHydrated: boolean
  /** Look up MBIDs for a recording. Returns cached data or fetches from MusicBrainz. */
  lookup: (artist: string, track: string, album: string) => Promise<MusicBrainzRecordingMbids | null>
  clearCache: () => void
}

const inflight = new Map<string, Promise<MusicBrainzRecordingMbids | null>>()

function makeKey(artist: string, track: string, album: string): string {
  return `${artist.toLowerCase()}::${track.toLowerCase()}::${album.toLowerCase()}`
}

export const useMbidStore = create<MbidStoreState>()(
  safePersist(
    (set, get) => ({
      recordings: {},
      _hasHydrated: false,

      lookup: async (artist, track, album) => {
        const key = makeKey(artist, track, album)
        const cached = get().recordings[key]
        if (cached) {
          const ttl = cached.data === null ? TTL_MS : TTL_MS
          if (Date.now() - cached.cachedAt < ttl) return cached.data
        }
        const existing = inflight.get(key)
        if (existing) return existing
        const promise = (async () => {
          try {
            const data = await musicbrainzLookupRecording(artist, track, album)
            set((s) => ({ recordings: { ...s.recordings, [key]: { data, cachedAt: Date.now() } } }))
            return data
          } catch {
            return null
          } finally {
            inflight.delete(key)
          }
        })()
        inflight.set(key, promise)
        return promise
      },

      clearCache: () => {
        set({ recordings: {} })
        useMbidStore.persist.clearStorage()
      },
    }),
    {
      name: "musicbrainz-mbid-cache-v1",
      partialize: (s) => ({ recordings: s.recordings }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.recordings = evictStaleEntries(state.recordings, EVICTION_TTL)
        }
        useMbidStore.setState({ _hasHydrated: true })
      },
    },
  ),
)
