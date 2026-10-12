import { buildExternalImageUrl } from "../../lib/imageUrl"
import { radioDirectoryErrorHint } from "../../lib/radioDirectoryError"
import { AudioBrowseCard } from "../shared/AudioBrowseCard"
import { MediaCardSkeleton, MediaShelfSkeleton } from "../shared/Skeleton"
import { MediaGrid } from "../shared/MediaGrid"
import { useLayoutEffect, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import clsx from "clsx"
import { ScrollRow } from "../ScrollRow"
import { useRadioStreamStore } from "../../stores/radioStreamStore"
import {
  radiobrowserSearch,
  radiobrowserTopStations,
  radiobrowserCountries,
  radiobrowserTags,
  type RadioStation,
} from "../../lib/radiobrowser"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Country code → flag emoji (e.g. "US" → "🇺🇸"). */
function countryFlag(code: string): string {
  if (!code || code.length !== 2) return ""
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split("")
      .map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  )
}

// ---------------------------------------------------------------------------
// Station Card
// ---------------------------------------------------------------------------

function StationCard({
  station,
  scrollItem = false,
}: {
  station: RadioStation
  scrollItem?: boolean
}) {
  const {
    playStation,
    toggleFavorite,
    isFavorite,
    currentStation,
    isStreamPlaying,
  } = useRadioStreamStore(
    useShallow((state) => ({
      playStation: state.playStation,
      toggleFavorite: state.toggleFavorite,
      isFavorite: state.isFavorite,
      currentStation: state.currentStation,
      isStreamPlaying: state.isStreamPlaying,
    }))
  )
  const active = currentStation?.uuid === station.uuid
  const description = [
    station.country
      ? `${countryFlag(station.country_code)} ${station.country}`
      : "",
    station.codec,
    station.bitrate > 0 ? `${station.bitrate}k` : "",
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <AudioBrowseCard
      title={station.name}
      description={description}
      src={buildExternalImageUrl(station.favicon)}
      intent="play"
      openLabel={`Play ${station.name}`}
      onOpen={() => playStation(station)}
      scrollItem={scrollItem}
      active={active}
      live={active && isStreamPlaying}
      favorite={isFavorite(station.uuid)}
      onFavorite={() => toggleFavorite(station)}
    />
  )
}

// ---------------------------------------------------------------------------
// Horizontal station row
// ---------------------------------------------------------------------------

function StationRow({
  title,
  stations,
  loading,
  restoreKey,
}: {
  title: string
  stations: RadioStation[]
  loading?: boolean
  restoreKey?: string
}) {
  if (!loading && stations.length === 0) return null
  if (loading) {
    return (
      <div className="mb-8">
        <span role="status" className="sr-only">
          Loading {title.toLowerCase()} stations…
        </span>
        <MediaShelfSkeleton title={title} />
      </div>
    )
  }
  return (
    <div className="mb-8">
      <ScrollRow title={title} restoreKey={restoreKey}>
        {stations.map((s) => (
          <StationCard key={s.uuid} station={s} scrollItem />
        ))}
      </ScrollRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type Tab = "featured" | "favorites" | "recent" | "country" | "genre"

const TABS: { key: Tab; label: string }[] = [
  { key: "featured", label: "Featured" },
  { key: "favorites", label: "Favorites" },
  { key: "recent", label: "Recent" },
  { key: "country", label: "By Country" },
  { key: "genre", label: "By Genre" },
]

/** Public lookups are cached only after a response accepted by its active view. */
function useRadioResource<T>(
  key: string | null,
  load: (key: string) => Promise<T>,
  delay = 0
) {
  const cache = useRef(new Map<string, T>())
  const loader = useRef(load)
  const currentKey = useRef(key)
  loader.current = load
  currentKey.current = key
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    key: string | null
    status: "loading" | "ready" | "error"
    data?: T
    errorHint?: string
  }>({ key: null, status: "loading" })
  useLayoutEffect(() => {
    let active = true
    const current = () => active && currentKey.current === key
    if (!key)
      return () => {
        active = false
      }
    if (cache.current.has(key)) {
      setState({ key, status: "ready", data: cache.current.get(key) })
      return () => {
        active = false
      }
    }
    setState({ key, status: "loading" })
    const run = async () => {
      try {
        const data = await loader.current(key)
        if (!current()) return
        cache.current.set(key, data)
        while (cache.current.size > 32)
          cache.current.delete(cache.current.keys().next().value!)
        setState({ key, status: "ready", data })
      } catch (error) {
        if (current())
          setState({
            key,
            status: "error",
            errorHint: radioDirectoryErrorHint(error),
          })
      }
    }
    const timer = delay
      ? setTimeout(() => {
          void run()
        }, delay)
      : null
    if (!delay) void run()
    return () => {
      active = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [key, attempt, delay])
  return {
    status:
      state.key === key
        ? state.status
        : cache.current.has(key ?? "")
          ? "ready"
          : "loading",
    data: state.key === key ? state.data : cache.current.get(key ?? ""),
    errorHint: state.key === key ? state.errorHint : undefined,
    retry: () => {
      if (key) cache.current.delete(key)
      setAttempt((value) => value + 1)
    },
  }
}
function RadioLoadError({
  message,
  retry,
  hint,
}: {
  message: string
  retry: () => void
  hint?: string
}) {
  return (
    <div role="alert" className="mb-4 text-sm text-red-400">
      <p>{message}</p>
      {hint && (
        <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
          {hint}
        </p>
      )}
      <button
        onClick={retry}
        className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white"
      >
        Try again
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function InternetRadioPage() {
  const [tab, setTab] = useState<Tab>("featured")
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const showSearch = searchQuery.trim().length > 0
  const search = useRadioResource(
    showSearch ? searchQuery.trim() : null,
    (name) => radiobrowserSearch({ name, limit: 30 }),
    400
  )
  const featured = useRadioResource(
    !showSearch && tab === "featured" ? "featured" : null,
    () =>
      Promise.all([
        radiobrowserTopStations("topvote", 15),
        radiobrowserTopStations("topclick", 15),
        radiobrowserTopStations("lastclick", 15),
      ])
  )
  const countryIndex = useRadioResource(
    !showSearch && tab === "country" ? "countries" : null,
    () => radiobrowserCountries()
  )
  const tagIndex = useRadioResource(
    !showSearch && tab === "genre" ? "tags" : null,
    () => radiobrowserTags(100)
  )
  const country = useRadioResource(
    !showSearch && tab === "country" ? selectedCountry : null,
    (name) => radiobrowserSearch({ country: name, limit: 50, order: "votes" })
  )
  const genre = useRadioResource(
    !showSearch && tab === "genre" ? selectedTag : null,
    (tag) => radiobrowserSearch({ tag, limit: 50, order: "votes" })
  )
  const searchResults = search.data ?? []
  const isSearching = search.status === "loading"
  const [topVoted, topClicked, trending] = featured.data ?? [[], [], []]
  const featuredLoading = featured.status === "loading"
  const countries = countryIndex.data ?? []
  const tags = tagIndex.data ?? []
  const countryStations = country.data ?? []
  const tagStations = genre.data ?? []
  const countryLoading = country.status === "loading"
  const tagLoading = genre.status === "loading"

  const { favorites, recentStations, clearRecent } = useRadioStreamStore(
    useShallow((s) => ({
      favorites: s.favorites,
      recentStations: s.recentStations,
      clearRecent: s.clearRecent,
    }))
  )

  return (
    <div className="broadcast-page">
      {/* Header */}
      <div className="broadcast-header">
        <div className="hidden">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="white">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z" />
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
          </svg>
        </div>
        <div>
          <p className="broadcast-eyebrow">Around the world</p>
          <h1 className="broadcast-title">Internet Radio</h1>
          <p className="broadcast-subtitle">
            Find a station, save a favorite, and tune in.
          </p>
        </div>

        {/* Search bar */}
        <div className="broadcast-search relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)]"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="currentColor"
          >
            <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search radio stations"
            placeholder="Search radio stations..."
            className="broadcast-input"
          />
          {searchQuery && (
            <button
              aria-label="Clear radio search"
              onClick={() => setSearchQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]"
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="currentColor"
              >
                <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Search results overlay */}
      {showSearch ? (
        <div>
          <h2 className="mb-4 text-lg font-bold text-white">
            {isSearching ? "Searching..." : `Results for "${searchQuery}"`}
          </h2>
          {search.status === "error" && (
            <RadioLoadError
              message="Could not search radio stations."
              retry={search.retry}
              hint={search.errorHint}
            />
          )}
          {!isSearching &&
            search.status !== "error" &&
            searchResults.length === 0 && (
              <p className="text-sm text-[color:var(--text-muted)]">
                No stations found. Try a different search term.
              </p>
            )}
          <MediaGrid>
            {isSearching &&
              searchResults.length === 0 &&
              Array.from({ length: 8 }, (_, i) => (
                <MediaCardSkeleton key={i} />
              ))}
            {searchResults.map((s) => (
              <StationCard key={s.uuid} station={s} />
            ))}
          </MediaGrid>
        </div>
      ) : (
        <>
          {/* Tab bar */}
          <div className="broadcast-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                aria-pressed={tab === t.key}
                onClick={() => setTab(t.key)}
                className={clsx(
                  "broadcast-pill rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                  tab === t.key
                    ? "bg-app-surface text-white"
                    : "text-[color:var(--text-secondary)] hover:text-[color:var(--text-secondary)]"
                )}
              >
                {t.label}
                {t.key === "favorites" && favorites.length > 0 && (
                  <span className="ml-1.5 text-xs text-[color:var(--text-muted)]">
                    ({favorites.length})
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {tab === "featured" && (
            <div>
              {featured.status === "error" ? (
                <RadioLoadError
                  message="Could not load featured stations."
                  retry={featured.retry}
                  hint={featured.errorHint}
                />
              ) : (
                <>
                  <StationRow
                    title="Top Voted"
                    stations={topVoted}
                    loading={featuredLoading}
                    restoreKey="radio-top-voted"
                  />
                  <StationRow
                    title="Most Popular"
                    stations={topClicked}
                    loading={featuredLoading}
                    restoreKey="radio-most-popular"
                  />
                  <StationRow
                    title="Trending Now"
                    stations={trending}
                    loading={featuredLoading}
                    restoreKey="radio-trending"
                  />
                </>
              )}
            </div>
          )}

          {tab === "favorites" && (
            <div>
              {favorites.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <svg
                    viewBox="0 0 24 24"
                    width="48"
                    height="48"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="mb-4 text-white/20"
                  >
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                  </svg>
                  <p className="text-sm text-[color:var(--text-muted)]">
                    No favorites yet
                  </p>
                  <p className="mt-1 text-xs text-[color:var(--text-muted)]">
                    Click the heart icon on any station to save it here
                  </p>
                </div>
              ) : (
                <MediaGrid>
                  {favorites.map((s) => (
                    <StationCard key={s.uuid} station={s} />
                  ))}
                </MediaGrid>
              )}
            </div>
          )}

          {tab === "recent" && (
            <div>
              {recentStations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <svg
                    viewBox="0 0 24 24"
                    width="48"
                    height="48"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="mb-4 text-white/20"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <p className="text-sm text-[color:var(--text-muted)]">
                    No recent stations
                  </p>
                  <p className="mt-1 text-xs text-[color:var(--text-muted)]">
                    Stations you play will appear here
                  </p>
                </div>
              ) : (
                <>
                  <div className="mb-3 flex justify-end">
                    <button
                      onClick={clearRecent}
                      className="text-xs text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-secondary)]"
                    >
                      Clear history
                    </button>
                  </div>
                  <MediaGrid>
                    {recentStations.map((s) => (
                      <StationCard key={s.uuid} station={s} />
                    ))}
                  </MediaGrid>
                </>
              )}
            </div>
          )}

          {tab === "country" && (
            <div>
              {selectedCountry ? (
                <>
                  <button
                    onClick={() => {
                      setSelectedCountry(null)
                    }}
                    className="mb-4 flex items-center gap-1.5 text-sm text-[color:var(--text-secondary)] transition-colors hover:text-white"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      fill="currentColor"
                    >
                      <path d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z" />
                    </svg>
                    Back to countries
                  </button>
                  <h3 className="mb-4 text-lg font-bold text-white">
                    {selectedCountry}
                  </h3>
                  {countryLoading ? (
                    <MediaGrid>
                      {Array.from({ length: 6 }).map((_, i) => (
                        <MediaCardSkeleton key={i} />
                      ))}
                    </MediaGrid>
                  ) : country.status === "error" ? (
                    <RadioLoadError
                      message="Could not load stations for this country."
                      retry={country.retry}
                      hint={country.errorHint}
                    />
                  ) : countryStations.length === 0 ? (
                    <p className="text-sm text-[color:var(--text-muted)]">
                      No stations found for this country.
                    </p>
                  ) : (
                    <MediaGrid>
                      {countryStations.map((s) => (
                        <StationCard key={s.uuid} station={s} />
                      ))}
                    </MediaGrid>
                  )}
                </>
              ) : countryIndex.status === "loading" ? (
                <p
                  role="status"
                  className="text-sm text-[color:var(--text-muted)]"
                >
                  Loading countries…
                </p>
              ) : countryIndex.status === "error" ? (
                <RadioLoadError
                  message="Could not load countries."
                  retry={countryIndex.retry}
                  hint={countryIndex.errorHint}
                />
              ) : countries.length === 0 ? (
                <p className="text-sm text-[color:var(--text-muted)]">
                  No countries available.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                  {countries.slice(0, 60).map((c) => (
                    <button
                      key={c.code || c.name}
                      onClick={() => setSelectedCountry(c.name)}
                      className="bg-app-surface/30 hover:bg-app-surface/60 flex items-center gap-2 rounded-lg p-3 text-left transition-colors"
                    >
                      <span className="text-xl">{countryFlag(c.code)}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">
                          {c.name}
                        </p>
                        <p className="text-xs text-[color:var(--text-muted)]">
                          {c.station_count.toLocaleString()} stations
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "genre" && (
            <div>
              {selectedTag ? (
                <>
                  <button
                    onClick={() => {
                      setSelectedTag(null)
                    }}
                    className="mb-4 flex items-center gap-1.5 text-sm text-[color:var(--text-secondary)] transition-colors hover:text-white"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      fill="currentColor"
                    >
                      <path d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z" />
                    </svg>
                    Back to genres
                  </button>
                  <h3 className="mb-4 text-lg font-bold capitalize text-white">
                    {selectedTag}
                  </h3>
                  {tagLoading ? (
                    <MediaGrid>
                      {Array.from({ length: 6 }).map((_, i) => (
                        <MediaCardSkeleton key={i} />
                      ))}
                    </MediaGrid>
                  ) : genre.status === "error" ? (
                    <RadioLoadError
                      message="Could not load stations for this genre."
                      retry={genre.retry}
                      hint={genre.errorHint}
                    />
                  ) : tagStations.length === 0 ? (
                    <p className="text-sm text-[color:var(--text-muted)]">
                      No stations found for this genre.
                    </p>
                  ) : (
                    <MediaGrid>
                      {tagStations.map((s) => (
                        <StationCard key={s.uuid} station={s} />
                      ))}
                    </MediaGrid>
                  )}
                </>
              ) : tagIndex.status === "loading" ? (
                <p
                  role="status"
                  className="text-sm text-[color:var(--text-muted)]"
                >
                  Loading genres…
                </p>
              ) : tagIndex.status === "error" ? (
                <RadioLoadError
                  message="Could not load genres."
                  retry={tagIndex.retry}
                  hint={tagIndex.errorHint}
                />
              ) : tags.length === 0 ? (
                <p className="text-sm text-[color:var(--text-muted)]">
                  No genres available.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {tags.map((t) => (
                    <button
                      key={t.name}
                      onClick={() => setSelectedTag(t.name)}
                      className="broadcast-pill"
                    >
                      {t.name}
                      <span className="ml-1.5 text-xs text-[color:var(--text-muted)]">
                        {t.station_count.toLocaleString()}
                      </span>
                    </button>
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
