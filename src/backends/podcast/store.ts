/**
 * Podcast store — subscriptions, feed cache, listen progress.
 *
 * Persisted to IndexedDB via Zustand persist. This is primary content
 * (not metadata augmentation), so it doesn't use createMetadataStore.
 */

import { create } from "zustand"
import { safePersist } from "../../stores/idbStorage"
import {
  podcastSearch,
  podcastGetFeed,
  podcastGetTop,
  type PodcastSearchResult,
  type PodcastDetail,
  type PodcastTopChart,
} from "./api"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PodcastSubscription {
  feedUrl: string
  title: string
  author: string
  artworkUrl: string
  addedAt: number // unix ms
}

interface CacheEntry<T> {
  data: T
  cachedAt: number
}

const FEED_TTL_MS = 30 * 60_000 // 30 minutes
const TOP_CHART_TTL_MS = 60 * 60_000 // 1 hour

// ---------------------------------------------------------------------------
// In-flight dedup maps (module-level, not persisted)
// ---------------------------------------------------------------------------

const inflightFeeds = new Map<string, Promise<PodcastDetail | null>>()
const inflightTopCharts = new Map<string, Promise<PodcastTopChart[]>>()

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface PodcastState {
  // Persisted
  subscriptions: PodcastSubscription[]
  feedCache: Record<string, CacheEntry<PodcastDetail>>
  topChartCache: Record<string, CacheEntry<PodcastTopChart[]>>
  listenProgress: Record<string, Record<string, number>> // feedUrl → guid → positionSecs
  completedEpisodes: Record<string, string[]> // feedUrl → guid[]

  // Transient
  searchResults: PodcastSearchResult[]
  isSearching: boolean
  lastError: string | null

  // Actions
  subscribe: (podcast: { feedUrl: string; title: string; author: string; artworkUrl: string }) => void
  unsubscribe: (feedUrl: string) => void
  isSubscribed: (feedUrl: string) => boolean
  getFeed: (feedUrl: string) => Promise<PodcastDetail | null>
  getTopChart: (category?: string, limit?: number) => Promise<PodcastTopChart[]>
  searchPodcasts: (query: string) => Promise<void>
  clearSearch: () => void
  clearError: () => void
  setEpisodeProgress: (feedUrl: string, guid: string, positionSecs: number) => void
  getEpisodeProgress: (feedUrl: string, guid: string) => number
  markEpisodeCompleted: (feedUrl: string, guid: string) => void
  isEpisodeCompleted: (feedUrl: string, guid: string) => boolean
}

export const usePodcastStore = create<PodcastState>()(
  safePersist(
    (set, get) => ({
      subscriptions: [],
      feedCache: {},
      topChartCache: {},
      listenProgress: {},
      completedEpisodes: {},
      searchResults: [],
      isSearching: false,
      lastError: null,

      subscribe: (podcast) => {
        const { subscriptions } = get()
        if (subscriptions.some(s => s.feedUrl === podcast.feedUrl)) return
        set({
          subscriptions: [
            ...subscriptions,
            { ...podcast, addedAt: Date.now() },
          ],
        })
      },

      unsubscribe: (feedUrl) => {
        set(s => ({
          subscriptions: s.subscriptions.filter(sub => sub.feedUrl !== feedUrl),
        }))
      },

      isSubscribed: (feedUrl) => {
        return get().subscriptions.some(s => s.feedUrl === feedUrl)
      },

      getFeed: async (feedUrl) => {
        const cached = get().feedCache[feedUrl]
        if (cached && Date.now() - cached.cachedAt < FEED_TTL_MS) return cached.data

        const existing = inflightFeeds.get(feedUrl)
        if (existing) return existing

        const promise = (async () => {
          try {
            const detail = await podcastGetFeed(feedUrl)
            set(s => ({
              feedCache: {
                ...s.feedCache,
                [feedUrl]: { data: detail, cachedAt: Date.now() },
              },
            }))
            return detail
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error("Failed to fetch podcast feed:", msg)
            set({ lastError: `Failed to load podcast feed: ${msg}` })
            throw err
          } finally {
            inflightFeeds.delete(feedUrl)
          }
        })()

        inflightFeeds.set(feedUrl, promise)
        return promise
      },

      getTopChart: async (category?, limit?) => {
        const key = `${category ?? "all"}-${limit ?? 20}`
        const cached = get().topChartCache[key]
        if (cached && Date.now() - cached.cachedAt < TOP_CHART_TTL_MS) return cached.data

        const existing = inflightTopCharts.get(key)
        if (existing) return existing

        const promise = (async () => {
          try {
            const results = await podcastGetTop(category, limit)
            set(s => ({
              topChartCache: {
                ...s.topChartCache,
                [key]: { data: results, cachedAt: Date.now() },
              },
            }))
            return results
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error("Failed to fetch top podcasts:", msg)
            set({ lastError: `Failed to load podcasts: ${msg}` })
            throw err
          } finally {
            inflightTopCharts.delete(key)
          }
        })()

        inflightTopCharts.set(key, promise)
        return promise
      },

      searchPodcasts: async (query) => {
        if (!query.trim()) {
          set({ searchResults: [], isSearching: false })
          return
        }
        set({ isSearching: true })
        try {
          const results = await podcastSearch(query, 20)
          set({ searchResults: results, isSearching: false })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          set({ searchResults: [], isSearching: false, lastError: `Search failed: ${msg}` })
        }
      },

      clearSearch: () => set({ searchResults: [], isSearching: false }),

      clearError: () => set({ lastError: null }),

      setEpisodeProgress: (feedUrl, guid, positionSecs) => {
        set(s => ({
          listenProgress: {
            ...s.listenProgress,
            [feedUrl]: {
              ...s.listenProgress[feedUrl],
              [guid]: positionSecs,
            },
          },
        }))
      },

      getEpisodeProgress: (feedUrl, guid) => {
        return get().listenProgress[feedUrl]?.[guid] ?? 0
      },

      markEpisodeCompleted: (feedUrl, guid) => {
        set(s => {
          const existing = s.completedEpisodes[feedUrl] ?? []
          if (existing.includes(guid)) return s
          return {
            completedEpisodes: {
              ...s.completedEpisodes,
              [feedUrl]: [...existing, guid],
            },
          }
        })
      },

      isEpisodeCompleted: (feedUrl, guid) => {
        return (get().completedEpisodes[feedUrl] ?? []).includes(guid)
      },
    }),
    {
      name: "podcast-store-v1",
      keyedArrays: { subscriptions: "feedUrl", "completedEpisodes.*": "$value" },
      validate: state => (state.subscriptions === undefined || (Array.isArray(state.subscriptions)
        && state.subscriptions.every(subscription => typeof subscription?.feedUrl === "string" && !!subscription.feedUrl))),
      partialize: (s) => ({
        subscriptions: s.subscriptions,
        feedCache: s.feedCache,
        topChartCache: s.topChartCache,
        listenProgress: s.listenProgress,
        completedEpisodes: s.completedEpisodes,
      }),
    },
  ),
)
