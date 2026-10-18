import { Button } from "../shared/Button"
import { AudioBrowseCard } from "../shared/AudioBrowseCard"
import { MediaCardSkeleton } from "../shared/Skeleton"
import { MediaGrid } from "../shared/MediaGrid"
import { useEffect, useRef, useState, useCallback } from "react"
import { useLocation } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { usePodcastStore } from "../../backends/podcast/store"
import { podcastGetCategories, podcastLookup } from "../../backends/podcast/api"
import type {
  PodcastCategory,
  PodcastSearchResult,
  PodcastTopChart,
} from "../../backends/podcast/api"
import { podcastFeedPath } from "../../lib/podcastRoute"
import { buildExternalImageUrl } from "../../lib/imageUrl"
import { ScrollRow } from "../ScrollRow"

// ---------------------------------------------------------------------------
// Podcast card (shared for search results, top charts, subscriptions)
// ---------------------------------------------------------------------------

function PodcastCard({
  title,
  author,
  artworkUrl,
  feedUrl,
  itunesId,
  scrollItem,
}: {
  title: string
  author: string
  artworkUrl: string
  feedUrl?: string
  itunesId?: number
  scrollItem?: boolean
}) {
  const [, navigate] = useLocation()
  const [lookupError, setLookupError] = useState(false)
  const lookupRevision = useRef(0)
  useEffect(() => {
    setLookupError(false)
    return () => {
      ++lookupRevision.current
    }
  }, [feedUrl, itunesId])

  const handleClick = useCallback(async () => {
    if (feedUrl) {
      const path = podcastFeedPath(feedUrl)
      if (path) navigate(path)
      else setLookupError(true)
      return
    }
    const revision = ++lookupRevision.current
    setLookupError(false)
    // Top chart items: look up the feed URL from iTunes ID
    if (itunesId) {
      try {
        const result = await podcastLookup(itunesId)
        if (revision !== lookupRevision.current) return
        const path = result?.feed_url ? podcastFeedPath(result.feed_url) : null
        if (path) navigate(path)
        else setLookupError(true)
      } catch {
        if (revision === lookupRevision.current) setLookupError(true)
      }
    }
  }, [feedUrl, itunesId, navigate])

  const artwork = buildExternalImageUrl(artworkUrl)
  return (
    <AudioBrowseCard
      title={title}
      description={author}
      src={artwork}
      openLabel={`Open podcast ${title}`}
      onOpen={() => void handleClick()}
      scrollItem={scrollItem}
      error={lookupError ? "Could not open podcast. Try again." : undefined}
    />
  )
}

// ---------------------------------------------------------------------------
// Error banner
// ---------------------------------------------------------------------------

function ErrorBanner({
  message,
  onDismiss,
  onRetry,
}: {
  message: string
  onDismiss: () => void
  onRetry?: () => void
}) {
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-red-500/10 px-4 py-2.5 text-sm text-red-700 ring-1 ring-red-500/20 dark:text-red-300"
    >
      <span className="min-w-0 flex-1 wrap-break-word">{message}</span>
      {onRetry && (
        <Button
          variant="bare"
          onClick={onRetry}
          className="shrink-0 rounded px-2.5 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-500/20 dark:text-red-200"
        >
          Retry
        </Button>
      )}
      <Button
        variant="bare"
        type="button"
        aria-label="Dismiss podcast error"
        onClick={onDismiss}
        className="shrink-0 rounded p-1 text-red-400 transition-colors hover:text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:text-red-200"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L8 6.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L9.06 8l4.72 4.72a.75.75 0 1 1-1.06 1.06L8 9.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L6.94 8 2.22 3.28a.75.75 0 0 1 0-1.06z" />
        </svg>
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function PodcastsPage() {
  const {
    subscriptions,
    searchResults,
    isSearching,
    lastError,
    searchPodcasts,
    clearSearch,
    clearError,
    getTopChart,
  } = usePodcastStore(
    useShallow((s) => ({
      subscriptions: s.subscriptions,
      searchResults: s.searchResults,
      isSearching: s.isSearching,
      lastError: s.lastError,
      searchPodcasts: s.searchPodcasts,
      clearSearch: s.clearSearch,
      clearError: s.clearError,
      getTopChart: s.getTopChart,
    }))
  )

  const [query, setQuery] = useState("")
  const [searchQueued, setSearchQueued] = useState(false)
  const [categories, setCategories] = useState<PodcastCategory[]>([])
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [topPodcasts, setTopPodcasts] = useState<PodcastTopChart[]>([])
  const [categoryPodcasts, setCategoryPodcasts] = useState<PodcastTopChart[]>(
    []
  )
  const [isLoadingTop, setIsLoadingTop] = useState(true)
  const [isLoadingCategory, setIsLoadingCategory] = useState(false)
  const [topError, setTopError] = useState(false)
  const [categoryError, setCategoryError] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)
  // Stale request guard — incremented on each category selection, checked on completion
  const categoryRequestId = useRef(0)
  const topRequestId = useRef(0)

  const loadTopPodcasts = useCallback(() => {
    const requestId = ++topRequestId.current
    setIsLoadingTop(true)
    setTopError(false)
    getTopChart(undefined, 25)
      .then((results) => {
        if (topRequestId.current !== requestId) return
        setTopPodcasts(results)
        setIsLoadingTop(false)
      })
      .catch(() => {
        if (topRequestId.current !== requestId) return
        setIsLoadingTop(false)
        setTopError(true)
      })
  }, [getTopChart])

  // Load categories + top podcasts on mount
  useEffect(() => {
    let current = true
    void podcastGetCategories()
      .then((results) => {
        if (current) setCategories(results)
      })
      .catch(() => {})
    loadTopPodcasts()
    return () => {
      current = false
      ++topRequestId.current
      ++categoryRequestId.current
      if (debounceRef.current) clearTimeout(debounceRef.current)
      clearSearch()
    }
  }, [loadTopPodcasts, clearSearch])

  // Debounced search
  const handleSearch = useCallback(
    (value: string) => {
      setQuery(value)
      setSearchQueued(!!value.trim())
      clearSearch() // Retire the old query before the new debounce can fire.
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (!value.trim()) {
        clearSearch()
        return
      }
      debounceRef.current = setTimeout(() => {
        setSearchQueued(false)
        void searchPodcasts(value)
      }, 400)
    },
    [searchPodcasts, clearSearch]
  )

  // Category selection with stale request guard
  const handleCategory = useCallback(
    (catName: string) => {
      if (selectedCategory === catName) {
        ++categoryRequestId.current
        setIsLoadingCategory(false)
        setSelectedCategory(null)
        setCategoryPodcasts([])
        setCategoryError(false)
        return
      }
      setSelectedCategory(catName)
      setCategoryPodcasts([])
      setIsLoadingCategory(true)
      setCategoryError(false)
      const reqId = ++categoryRequestId.current
      getTopChart(catName, 25)
        .then((results) => {
          // Ignore stale responses from superseded category selections
          if (categoryRequestId.current !== reqId) return
          setCategoryPodcasts(results)
          setIsLoadingCategory(false)
        })
        .catch(() => {
          if (categoryRequestId.current !== reqId) return
          setIsLoadingCategory(false)
          setCategoryError(true)
        })
    },
    [selectedCategory, getTopChart]
  )

  const retryCategory = useCallback(() => {
    if (selectedCategory) {
      setIsLoadingCategory(true)
      setCategoryError(false)
      const reqId = ++categoryRequestId.current
      getTopChart(selectedCategory, 25)
        .then((results) => {
          if (categoryRequestId.current !== reqId) return
          setCategoryPodcasts(results)
          setIsLoadingCategory(false)
        })
        .catch(() => {
          if (categoryRequestId.current !== reqId) return
          setIsLoadingCategory(false)
          setCategoryError(true)
        })
    }
  }, [selectedCategory, getTopChart])

  const isSearchMode = query.trim().length > 0

  return (
    <div className="broadcast-page">
      {/* Error banner from store (rate limit / network errors) */}
      {lastError && (
        <ErrorBanner
          message={
            /429|rate.limit|too many/i.test(lastError)
              ? "The podcast directory is busy. Try again in a moment."
              : "Podcasts could not be loaded. Please try again."
          }
          onDismiss={clearError}
        />
      )}

      {/* Header */}
      <div className="broadcast-header">
        <div>
          <h1 className="broadcast-title">Podcasts</h1>
          <p className="broadcast-subtitle">
            Your subscriptions and new voices to discover.
          </p>
        </div>
        <div className="broadcast-search relative">
          <input
            type="text"
            aria-label="Search podcasts"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search podcasts..."
            className="broadcast-input"
          />
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="currentColor"
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-(--text-secondary)"
          >
            <path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z" />
          </svg>
          {query && (
            <Button
              variant="bare"
              type="button"
              aria-label="Clear podcast search"
              onClick={() => handleSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-(--text-secondary) hover:text-white"
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="currentColor"
              >
                <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L8 6.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L9.06 8l4.72 4.72a.75.75 0 1 1-1.06 1.06L8 9.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L6.94 8 2.22 3.28a.75.75 0 0 1 0-1.06z" />
              </svg>
            </Button>
          )}
        </div>
      </div>

      {/* Search results mode */}
      {isSearchMode ? (
        <div>
          <h2 className="mb-4 text-xl font-bold">
            {isSearching || searchQueued
              ? "Searching..."
              : `Results for "${query}"`}
          </h2>
          {!isSearching && !searchQueued && searchResults.length === 0 && (
            <p className="text-(--text-secondary)">
              No podcasts found.
            </p>
          )}
          <MediaGrid>
            {(isSearching || searchQueued) && searchResults.length === 0 && Array.from({ length: 8 }, (_, i) => <MediaCardSkeleton key={i} />)}
            {searchResults.map((p: PodcastSearchResult) => (
              <PodcastCard
                key={p.id}
                title={p.name}
                author={p.artist_name}
                artworkUrl={p.artwork_url}
                feedUrl={p.feed_url}
              />
            ))}
          </MediaGrid>
        </div>
      ) : (
        <>
          {/* Your Subscriptions */}
          {subscriptions.length > 0 && (
            <div className="mb-10">
              <ScrollRow title="Your Subscriptions" restoreKey="podcast-subs">
                {subscriptions.map((sub) => (
                  <PodcastCard
                    key={sub.feedUrl}
                    title={sub.title}
                    author={sub.author}
                    artworkUrl={sub.artworkUrl}
                    feedUrl={sub.feedUrl}
                    scrollItem
                  />
                ))}
              </ScrollRow>
            </div>
          )}

          {/* Top Podcasts */}
          <div className="mb-10">
            {topError && !isLoadingTop ? (
              <div>
                <h2 className="mb-4 text-xl font-bold">Top Podcasts</h2>
                <ErrorBanner
                  message="Failed to load top podcasts."
                  onDismiss={() => setTopError(false)}
                  onRetry={loadTopPodcasts}
                />
              </div>
            ) : (
              <ScrollRow title="Top Podcasts" restoreKey="podcast-top">
                {isLoadingTop
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <MediaCardSkeleton key={i} scrollItem />
                    ))
                  : topPodcasts.map((p: PodcastTopChart, idx: number) => (
                      <PodcastCard
                        key={`${p.itunes_id}-${idx}`}
                        title={p.name}
                        author={p.artist_name}
                        artworkUrl={p.artwork_url}
                        feedUrl={p.feed_url || undefined}
                        itunesId={p.itunes_id}
                        scrollItem
                      />
                    ))}
              </ScrollRow>
            )}
          </div>

          {/* Categories */}
          {categories.length > 0 && (
            <div className="mb-6">
              <h2 className="mb-4 text-xl font-bold">Categories</h2>
              <div className="flex flex-wrap gap-2">
                {categories.map((cat) => (
                  <Button
                    variant="bare"
                    key={cat.id}
                    onClick={() => handleCategory(cat.name)}
                    aria-pressed={selectedCategory === cat.name}
                    className={`broadcast-pill rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                      selectedCategory === cat.name
                        ? "bg-accent text-black"
                        : "bg-white/10 text-white hover:bg-white/20"
                    }`}
                  >
                    {cat.name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Category results */}
          {selectedCategory && (
            <div>
              <h2 className="mb-4 text-xl font-bold">{selectedCategory}</h2>
              {categoryError && !isLoadingCategory ? (
                <ErrorBanner
                  message={`Failed to load ${selectedCategory} podcasts.`}
                  onDismiss={() => setCategoryError(false)}
                  onRetry={retryCategory}
                />
              ) : isLoadingCategory ? (
                <MediaGrid>
                  {Array.from({ length: 12 }).map((_, i) => (
                    <MediaCardSkeleton key={i} />
                  ))}
                </MediaGrid>
              ) : categoryPodcasts.length === 0 ? (
                <p className="text-(--text-secondary)">
                  No podcasts found in this category.
                </p>
              ) : (
                <MediaGrid>
                  {categoryPodcasts.map((p: PodcastTopChart, idx: number) => (
                    <PodcastCard
                      key={`${p.itunes_id}-${idx}`}
                      title={p.name}
                      author={p.artist_name}
                      artworkUrl={p.artwork_url}
                      feedUrl={p.feed_url || undefined}
                      itunesId={p.itunes_id}
                    />
                  ))}
                </MediaGrid>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
