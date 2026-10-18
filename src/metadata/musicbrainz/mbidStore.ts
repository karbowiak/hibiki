/**
 * MusicBrainz recording MBID cache — persisted to SQLite via Zustand persist.
 *
 * Caches recording MBIDs (+ associated artist/release/release-group MBIDs)
 * keyed by `artist::track::album`. Used by ListenBrainz to submit properly
 * matched listens even when Plex doesn't provide MBIDs.
 *
 * 30-day TTL — MBIDs are stable identifiers that rarely change.
 */

import { CacheRequests } from "../../lib/cacheRequests"
import { create } from "zustand"
import { safePersist } from "../../stores/sqliteStorage"
import { evictStaleEntries } from "../../stores/cacheUtils"
import {
  musicbrainzLookupRecording,
  type MusicBrainzRecordingMbids,
} from "./api"

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
  lookup: (
    artist: string,
    track: string,
    album: string
  ) => Promise<MusicBrainzRecordingMbids | null>
  clearCache: () => void
}

const requests = new CacheRequests()
const MAX_RECORDINGS = 5000

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
          if (Date.now() - cached.cachedAt < TTL_MS) return cached.data
        }
        return requests.load(
          key,
          () => musicbrainzLookupRecording(artist, track, album),
          (data) => {
            set((state) => ({
              recordings: evictStaleEntries(
                { ...state.recordings, [key]: { data, cachedAt: Date.now() } },
                EVICTION_TTL,
                MAX_RECORDINGS,
                key
              ),
            }))
          }
        )
      },

      clearCache: () => {
        requests.clear()
        set({ recordings: {} })
        useMbidStore.persist.clearStorage()
      },
    }),
    {
      name: "musicbrainz-mbid-cache-v1",
      partialize: (s) => ({ recordings: s.recordings }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.recordings = evictStaleEntries(
            state.recordings,
            EVICTION_TTL,
            MAX_RECORDINGS
          )
        }
        useMbidStore.setState({ _hasHydrated: true })
      },
    }
  )
)
