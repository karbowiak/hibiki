import { useEffect, useRef, useState, useCallback } from "react"
import { useLocation } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { usePodcastStore } from "../../backends/podcast/store"
import { podcastGetCategories, podcastLookup } from "../../backends/podcast/api"
import type { PodcastCategory, PodcastSearchResult, PodcastTopChart } from "../../backends/podcast/api"
import { ArtworkImage } from "../shared/ArtworkImage"
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
  useEffect(() => { setLookupError(false); return () => { ++lookupRevision.current } }, [feedUrl, itunesId])

  const handleClick = useCallback(async () => {
    if (feedUrl) {
      navigate(`/podcast/${btoa(feedUrl)}`)
      return
    }
    const revision = ++lookupRevision.current
    setLookupError(false)
    // Top chart items: look up the feed URL from iTunes ID
    if (itunesId) {
      try {
        const result = await podcastLookup(itunesId)
        if (revision !== lookupRevision.current) return
        if (result?.feed_url) navigate(`/podcast/${btoa(result.feed_url)}`)
        else setLookupError(true)
      } catch { if (revision === lookupRevision.current) setLookupError(true) }
    }
  }, [feedUrl, itunesId, navigate])

  const artwork = buildExternalImageUrl(artworkUrl)
  return (
    <div
      onClick={() => void handleClick()}
      className="group flex-shrink-0 cursor-pointer no-underline"
      style={scrollItem ? { width: "var(--card-size, 160px)" } : undefined}
    >
      <div className="aspect-square w-full overflow-hidden rounded-lg bg-white/5 shadow-lg transition-shadow group-hover:shadow-xl">
        {artwork ? (
          <ArtworkImage src={artwork} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-3xl text-gray-500">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM6 10a1 1 0 1 0-2 0 8 8 0 0 0 7 7.93V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-3.07A8 8 0 0 0 20 10a1 1 0 1 0-2 0 6 6 0 0 1-12 0z" />
            </svg>
          </div>
        )}
      </div>
      <p className="mt-2 truncate text-sm font-medium text-[color:var(--text-primary)]">{title}</p>
      <p className="truncate text-xs text-gray-400">{author}</p>
      {lookupError && <p role="alert" className="text-xs text-red-300">Could not open podcast. Click to retry.</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Error banner
// ---------------------------------------------------------------------------

function ErrorBanner({ message, onDismiss, onRetry }: { message: string; onDismiss: () => void; onRetry?: () => void }) {
  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg bg-red-500/10 px-4 py-2.5 text-sm text-red-300 ring-1 ring-red-500/20">
      <span className="flex-1">{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 rounded px-2.5 py-1 text-xs font-medium text-red-200 hover:bg-red-500/20 transition-colors">
          Retry
        </button>
      )}
      <button onClick={onDismiss} className="shrink-0 text-red-400 hover:text-red-200 transition-colors">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L8 6.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L9.06 8l4.72 4.72a.75.75 0 1 1-1.06 1.06L8 9.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L6.94 8 2.22 3.28a.75.75 0 0 1 0-1.06z" />
        </svg>
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function PodcastsPage() {
  const { subscriptions, searchResults, isSearching, lastError, searchPodcasts, clearSearch, clearError, getTopChart } =
    usePodcastStore(useShallow(s => ({
      subscriptions: s.subscriptions,
      searchResults: s.searchResults,
      isSearching: s.isSearching,
      lastError: s.lastError,
      searchPodcasts: s.searchPodcasts,
      clearSearch: s.clearSearch,
      clearError: s.clearError,
      getTopChart: s.getTopChart,
    })))

  const [query, setQuery] = useState("")
  const [searchQueued, setSearchQueued] = useState(false)
  const [categories, setCategories] = useState<PodcastCategory[]>([])
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [topPodcasts, setTopPodcasts] = useState<PodcastTopChart[]>([])
  const [categoryPodcasts, setCategoryPodcasts] = useState<PodcastTopChart[]>([])
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
    getTopChart(undefined, 25).then(results => {
      if (topRequestId.current !== requestId) return
      setTopPodcasts(results)
      setIsLoadingTop(false)
    }).catch(() => {
      if (topRequestId.current !== requestId) return
      setIsLoadingTop(false)
      setTopError(true)
    })
  }, [getTopChart])

  // Load categories + top podcasts on mount
  useEffect(() => {
    let current = true
    void podcastGetCategories().then(results => { if (current) setCategories(results) }).catch(() => {})
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
  const handleSearch = useCallback((value: string) => {
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
  }, [searchPodcasts, clearSearch])

  // Category selection with stale request guard
  const handleCategory = useCallback((catName: string) => {
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
    getTopChart(catName, 25).then(results => {
      // Ignore stale responses from superseded category selections
      if (categoryRequestId.current !== reqId) return
      setCategoryPodcasts(results)
      setIsLoadingCategory(false)
    }).catch(() => {
      if (categoryRequestId.current !== reqId) return
      setIsLoadingCategory(false)
      setCategoryError(true)
    })
  }, [selectedCategory, getTopChart])

  const retryCategory = useCallback(() => {
    if (selectedCategory) {
      setIsLoadingCategory(true)
      setCategoryError(false)
      const reqId = ++categoryRequestId.current
      getTopChart(selectedCategory, 25).then(results => {
        if (categoryRequestId.current !== reqId) return
        setCategoryPodcasts(results)
        setIsLoadingCategory(false)
      }).catch(() => {
        if (categoryRequestId.current !== reqId) return
        setIsLoadingCategory(false)
        setCategoryError(true)
      })
    }
  }, [selectedCategory, getTopChart])

  const isSearchMode = query.trim().length > 0

  return (
    <div className="p-8">
      {/* Error banner from store (rate limit / network errors) */}
      {lastError && (
        <ErrorBanner message={lastError} onDismiss={clearError} />
      )}

      {/* Header */}
      <div className="mb-8 flex items-center gap-4">
        <h1 className="text-3xl font-bold">Podcasts</h1>
        <div className="relative flex-1 max-w-md">
          <input
            type="text"
            value={query}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search podcasts..."
            className="w-full rounded-full bg-white/10 px-4 py-2 pl-10 text-sm text-white placeholder-gray-400 outline-none ring-1 ring-white/10 transition-all focus:bg-white/15 focus:ring-white/20"
          />
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="currentColor"
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400"
          >
            <path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z" />
          </svg>
          {query && (
            <button
              onClick={() => handleSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L8 6.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L9.06 8l4.72 4.72a.75.75 0 1 1-1.06 1.06L8 9.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L6.94 8 2.22 3.28a.75.75 0 0 1 0-1.06z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Search results mode */}
      {isSearchMode ? (
        <div>
          <h2 className="mb-4 text-xl font-bold">
            {isSearching || searchQueued ? "Searching..." : `Results for "${query}"`}
          </h2>
          {!isSearching && !searchQueued && searchResults.length === 0 && (
            <p className="text-gray-400">No podcasts found.</p>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-6">
            {searchResults.map((p: PodcastSearchResult) => (
              <PodcastCard
                key={p.id}
                title={p.name}
                author={p.artist_name}
                artworkUrl={p.artwork_url}
                feedUrl={p.feed_url}
              />
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Your Subscriptions */}
          {subscriptions.length > 0 && (
            <div className="mb-10">
              <ScrollRow title="Your Subscriptions" restoreKey="podcast-subs">
                {subscriptions.map(sub => (
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
                {isLoadingTop ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="flex-shrink-0 animate-pulse" style={{ width: "var(--card-size, 160px)" }}>
                      <div className="aspect-square w-full rounded-lg bg-white/5" />
                      <div className="mt-2 h-3 w-3/4 rounded bg-white/5" />
                      <div className="mt-1 h-2.5 w-1/2 rounded bg-white/5" />
                    </div>
                  ))
                ) : (
                  topPodcasts.map((p: PodcastTopChart, idx: number) => (
                    <PodcastCard
                      key={`${p.itunes_id}-${idx}`}
                      title={p.name}
                      author={p.artist_name}
                      artworkUrl={p.artwork_url}
                      feedUrl={p.feed_url || undefined}
                      itunesId={p.itunes_id}
                      scrollItem
                    />
                  ))
                )}
              </ScrollRow>
            )}
          </div>

          {/* Categories */}
          <div className="mb-6">
            <h2 className="mb-4 text-xl font-bold">Categories</h2>
            <div className="flex flex-wrap gap-2">
              {categories.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => handleCategory(cat.name)}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                    selectedCategory === cat.name
                      ? "bg-accent text-black"
                      : "bg-white/10 text-white hover:bg-white/20"
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </div>

          {/* Category results */}
          {selectedCategory && (
            <div>
              <h2 className="mb-4 text-xl font-bold">
                {selectedCategory}
              </h2>
              {categoryError && !isLoadingCategory ? (
                <ErrorBanner
                  message={`Failed to load ${selectedCategory} podcasts.`}
                  onDismiss={() => setCategoryError(false)}
                  onRetry={retryCategory}
                />
              ) : isLoadingCategory ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-6">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i} className="animate-pulse">
                      <div className="aspect-square w-full rounded-lg bg-white/5" />
                      <div className="mt-2 h-3 w-3/4 rounded bg-white/5" />
                      <div className="mt-1 h-2.5 w-1/2 rounded bg-white/5" />
                    </div>
                  ))}
                </div>
              ) : categoryPodcasts.length === 0 ? (
                <p className="text-gray-400">No podcasts found in this category.</p>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-6">
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
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
