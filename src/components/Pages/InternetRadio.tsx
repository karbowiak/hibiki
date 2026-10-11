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
    ...code.toUpperCase().split("").map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
  )
}

// ---------------------------------------------------------------------------
// Station Card
// ---------------------------------------------------------------------------

function StationCard({ station }: { station: RadioStation }) {
  const { playStation, toggleFavorite, isFavorite, currentStation, isStreamPlaying } =
    useRadioStreamStore(useShallow(s => ({
      playStation: s.playStation,
      toggleFavorite: s.toggleFavorite,
      isFavorite: s.isFavorite,
      currentStation: s.currentStation,
      isStreamPlaying: s.isStreamPlaying,
    })))

  const fav = isFavorite(station.uuid)
  const isActive = currentStation?.uuid === station.uuid
  const tags = station.tags.slice(0, 3)
  const codecLabel = [station.codec, station.bitrate > 0 ? `${station.bitrate}k` : ""]
    .filter(Boolean).join(" ")

  return (
    <div
      className={clsx(
        "group relative flex items-center gap-3 rounded-lg p-3 transition-colors cursor-pointer",
        isActive ? "bg-accent/15 ring-1 ring-accent/30" : "bg-app-surface/50 hover:bg-app-surface"
      )}
      onClick={() => playStation(station)}
    >
      {/* Favicon */}
      <div className="h-12 w-12 flex-shrink-0 rounded-lg overflow-hidden bg-app-surface flex items-center justify-center">
        {station.favicon ? (
          <img
            src={station.favicon}
            alt=""
            className="h-full w-full object-cover"
            onError={e => { (e.target as HTMLImageElement).style.display = "none" }}
          />
        ) : (
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" className="text-white/30">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
          </svg>
        )}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-white">{station.name}</p>
          {isActive && isStreamPlaying && (
            <span className="flex-shrink-0 flex items-center gap-1 rounded-full bg-red-500/20 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase text-red-400">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
              LIVE
            </span>
          )}
        </div>
        <p className="truncate text-xs text-white/50 mt-0.5">
          {station.country && <>{countryFlag(station.country_code)} {station.country}</>}
          {codecLabel && <span className="ml-2 text-white/30">{codecLabel}</span>}
        </p>
        {tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {tags.map(t => (
              <span key={t} className="rounded-full bg-white/5 px-2 py-0.5 text-[0.625rem] text-white/40">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Favorite button */}
      <button
        onClick={e => { e.stopPropagation(); toggleFavorite(station) }}
        className={clsx(
          "flex-shrink-0 h-8 w-8 flex items-center justify-center rounded-full transition-colors",
          fav ? "text-accent" : "text-white/30 opacity-0 group-hover:opacity-100 hover:text-white/60"
        )}
        title={fav ? "Remove from favorites" : "Add to favorites"}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill={fav ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Station Media Card (vertical card for scroll rows — matches MediaCard style)
// ---------------------------------------------------------------------------

function StationMediaCard({ station }: { station: RadioStation }) {
  const [imgError, setImgError] = useState(false)
  const { playStation, toggleFavorite, isFavorite, currentStation, isStreamPlaying } =
    useRadioStreamStore(useShallow(s => ({
      playStation: s.playStation,
      toggleFavorite: s.toggleFavorite,
      isFavorite: s.isFavorite,
      currentStation: s.currentStation,
      isStreamPlaying: s.isStreamPlaying,
    })))

  const fav = isFavorite(station.uuid)
  const isActive = currentStation?.uuid === station.uuid
  const codecLabel = [station.codec, station.bitrate > 0 ? `${station.bitrate}k` : ""]
    .filter(Boolean).join(" ")
  const descParts = [
    station.country ? `${countryFlag(station.country_code)} ${station.country}` : "",
    codecLabel,
  ].filter(Boolean)

  return (
    <div
      className={clsx(
        "group cursor-pointer rounded-md p-3 transition-colors flex-shrink-0",
        isActive ? "bg-accent/15 ring-1 ring-accent/30" : "bg-app-card hover:bg-hl-card"
      )}
      style={{ width: "var(--card-size, 160px)" }}
      onClick={() => playStation(station)}
    >
      <div className="relative mb-3">
        {station.favicon && !imgError ? (
          <img
            src={station.favicon}
            alt=""
            loading="lazy"
            draggable={false}
            className="aspect-square w-full rounded-md object-cover bg-app-surface"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="aspect-square w-full rounded-md bg-app-surface flex items-center justify-center">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor" className="text-white/20">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
          </div>
        )}
        {/* Play button overlay */}
        <div className="absolute inset-0 flex items-end justify-end p-2 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200">
          <button
            onClick={e => { e.stopPropagation(); playStation(station) }}
            aria-label={`Play ${station.name}`}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-black shadow-lg hover:scale-105 hover:brightness-110 active:scale-95 transition-all"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <polygon points="3,2 13,8 3,14" />
            </svg>
          </button>
        </div>
        {/* LIVE badge */}
        {isActive && isStreamPlaying && (
          <span className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-full bg-red-500/90 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase text-white shadow">
            <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
            LIVE
          </span>
        )}
        {/* Favorite heart */}
        <button
          onClick={e => { e.stopPropagation(); toggleFavorite(station) }}
          className={clsx(
            "absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 transition-all",
            fav ? "text-accent opacity-100" : "text-white opacity-0 group-hover:opacity-100 hover:text-accent"
          )}
          title={fav ? "Remove from favorites" : "Add to favorites"}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill={fav ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </button>
      </div>
      <div className="truncate text-sm font-semibold text-white">{station.name}</div>
      <div className="mt-1 truncate text-xs text-neutral-400">{descParts.join(" · ")}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Horizontal station row
// ---------------------------------------------------------------------------

function StationRow({ title, stations, loading, restoreKey }: { title: string; stations: RadioStation[]; loading?: boolean; restoreKey?: string }) {
  if (!loading && stations.length === 0) return null
  if (loading) {
    return (
      <div className="mb-8">
        <span className="mb-3 block text-2xl font-bold">{title}</span>
        <div className="flex gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex-shrink-0 animate-pulse rounded-md bg-white/5" style={{ width: "var(--card-size, 160px)", aspectRatio: "1 / 1.3" }} />
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="mb-8">
      <ScrollRow title={title} restoreKey={restoreKey}>
        {stations.map(s => (
          <StationMediaCard key={s.uuid} station={s} />
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
function useRadioResource<T>(key: string | null, load: (key: string) => Promise<T>, delay = 0) {
  const cache = useRef(new Map<string, T>())
  const loader = useRef(load)
  const currentKey = useRef(key)
  loader.current = load
  currentKey.current = key
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ key: string | null; status: "loading" | "ready" | "error"; data?: T }>({ key: null, status: "loading" })
  useLayoutEffect(() => {
    let active = true
    const current = () => active && currentKey.current === key
    if (!key) return () => { active = false }
    if (cache.current.has(key)) {
      setState({ key, status: "ready", data: cache.current.get(key) })
      return () => { active = false }
    }
    setState({ key, status: "loading" })
    const run = async () => {
      try {
        const data = await loader.current(key)
        if (!current()) return
        cache.current.set(key, data)
        while (cache.current.size > 32) cache.current.delete(cache.current.keys().next().value!)
        setState({ key, status: "ready", data })
      } catch {
        if (current()) setState({ key, status: "error" })
      }
    }
    const timer = delay ? setTimeout(() => { void run() }, delay) : null
    if (!delay) void run()
    return () => { active = false; if (timer !== null) clearTimeout(timer) }
  }, [key, attempt, delay])
  return {
    status: state.key === key ? state.status : cache.current.has(key ?? "") ? "ready" : "loading",
    data: state.key === key ? state.data : cache.current.get(key ?? ""),
    retry: () => { if (key) cache.current.delete(key); setAttempt(value => value + 1) },
  }
}
function RadioLoadError({ message, retry }: { message: string; retry: () => void }) {
  return <div role="alert" className="mb-4 text-sm text-red-400"><p>{message}</p><button onClick={retry} className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white">Try again</button></div>
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
  const search = useRadioResource(showSearch ? searchQuery.trim() : null, name => radiobrowserSearch({ name, limit: 30 }), 400)
  const featured = useRadioResource(!showSearch && tab === "featured" ? "featured" : null, () => Promise.all([
    radiobrowserTopStations("topvote", 15), radiobrowserTopStations("topclick", 15), radiobrowserTopStations("lastclick", 15),
  ]))
  const countryIndex = useRadioResource(!showSearch && tab === "country" ? "countries" : null, () => radiobrowserCountries())
  const tagIndex = useRadioResource(!showSearch && tab === "genre" ? "tags" : null, () => radiobrowserTags(100))
  const country = useRadioResource(!showSearch && tab === "country" ? selectedCountry : null, name => radiobrowserSearch({ country: name, limit: 50, order: "votes" }))
  const genre = useRadioResource(!showSearch && tab === "genre" ? selectedTag : null, tag => radiobrowserSearch({ tag, limit: 50, order: "votes" }))
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
    useShallow(s => ({ favorites: s.favorites, recentStations: s.recentStations, clearRecent: s.clearRecent }))
  )

  return (
    <div className="p-8">
      {/* Header */}
      <div className="mb-6 flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="white">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z" />
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
          </svg>
        </div>
        <div>
          <h1 className="text-3xl font-bold text-white">Internet Radio</h1>
          <p className="text-sm text-white/50">45,000+ stations worldwide</p>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative mb-6">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40"
          viewBox="0 0 16 16" width="16" height="16" fill="currentColor"
        >
          <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z" />
        </svg>
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          aria-label="Search radio stations"
          placeholder="Search radio stations..."
          className="w-full rounded-lg bg-white/10 py-2.5 pl-10 pr-4 text-sm text-[color:var(--text-primary)] placeholder-white/40 outline-none focus:bg-white/15 transition-colors"
        />
        {searchQuery && (
          <button
            aria-label="Clear radio search"
            onClick={() => setSearchQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
            </svg>
          </button>
        )}
      </div>

      {/* Search results overlay */}
      {showSearch ? (
        <div>
          <h2 className="mb-4 text-lg font-bold text-white">
            {isSearching ? "Searching..." : `Results for "${searchQuery}"`}
          </h2>
          {search.status === "error" && <RadioLoadError message="Could not search radio stations." retry={search.retry} />}
          {!isSearching && search.status !== "error" && searchResults.length === 0 && (
            <p className="text-sm text-white/40">No stations found. Try a different search term.</p>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {searchResults.map(s => <StationCard key={s.uuid} station={s} />)}
          </div>
        </div>
      ) : (
        <>
          {/* Tab bar */}
          <div className="mb-6 flex gap-1 rounded-lg bg-app-surface/30 p-1">
            {TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={clsx(
                  "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                  tab === t.key
                    ? "bg-app-surface text-white"
                    : "text-white/50 hover:text-white/70"
                )}
              >
                {t.label}
                {t.key === "favorites" && favorites.length > 0 && (
                  <span className="ml-1.5 text-xs text-white/30">({favorites.length})</span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {tab === "featured" && (
            <div>
              {featured.status === "error" ? <RadioLoadError message="Could not load featured stations." retry={featured.retry} /> : <>
              <StationRow title="Top Voted" stations={topVoted} loading={featuredLoading} restoreKey="radio-top-voted" />
              <StationRow title="Most Popular" stations={topClicked} loading={featuredLoading} restoreKey="radio-most-popular" />
              <StationRow title="Trending Now" stations={trending} loading={featuredLoading} restoreKey="radio-trending" />
              </>}
            </div>
          )}

          {tab === "favorites" && (
            <div>
              {favorites.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/20 mb-4">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                  </svg>
                  <p className="text-white/40 text-sm">No favorites yet</p>
                  <p className="text-white/25 text-xs mt-1">Click the heart icon on any station to save it here</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {favorites.map(s => <StationCard key={s.uuid} station={s} />)}
                </div>
              )}
            </div>
          )}

          {tab === "recent" && (
            <div>
              {recentStations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/20 mb-4">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <p className="text-white/40 text-sm">No recent stations</p>
                  <p className="text-white/25 text-xs mt-1">Stations you play will appear here</p>
                </div>
              ) : (
                <>
                  <div className="mb-3 flex justify-end">
                    <button
                      onClick={clearRecent}
                      className="text-xs text-white/30 hover:text-white/60 transition-colors"
                    >
                      Clear history
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {recentStations.map(s => <StationCard key={s.uuid} station={s} />)}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "country" && (
            <div>
              {selectedCountry ? (
                <>
                  <button
                    onClick={() => { setSelectedCountry(null) }}
                    className="mb-4 flex items-center gap-1.5 text-sm text-white/50 hover:text-white transition-colors"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                      <path d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z" />
                    </svg>
                    Back to countries
                  </button>
                  <h3 className="mb-4 text-lg font-bold text-white">{selectedCountry}</h3>
                  {countryLoading ? (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="h-20 animate-pulse rounded-lg bg-app-surface/50" />
                      ))}
                    </div>
                  ) : country.status === "error" ? <RadioLoadError message="Could not load stations for this country." retry={country.retry} /> : countryStations.length === 0 ? <p className="text-sm text-white/40">No stations found for this country.</p> : (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {countryStations.map(s => <StationCard key={s.uuid} station={s} />)}
                    </div>
                  )}
                </>
              ) : countryIndex.status === "loading" ? <p role="status" className="text-sm text-white/40">Loading countries…</p> : countryIndex.status === "error" ? <RadioLoadError message="Could not load countries." retry={countryIndex.retry} /> : countries.length === 0 ? <p className="text-sm text-white/40">No countries available.</p> : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                  {countries.slice(0, 60).map(c => (
                    <button
                      key={c.code || c.name}
                      onClick={() => setSelectedCountry(c.name)}
                      className="flex items-center gap-2 rounded-lg bg-app-surface/30 p-3 text-left transition-colors hover:bg-app-surface/60"
                    >
                      <span className="text-xl">{countryFlag(c.code)}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">{c.name}</p>
                        <p className="text-xs text-white/30">{c.station_count.toLocaleString()} stations</p>
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
                    onClick={() => { setSelectedTag(null) }}
                    className="mb-4 flex items-center gap-1.5 text-sm text-white/50 hover:text-white transition-colors"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                      <path d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z" />
                    </svg>
                    Back to genres
                  </button>
                  <h3 className="mb-4 text-lg font-bold text-white capitalize">{selectedTag}</h3>
                  {tagLoading ? (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="h-20 animate-pulse rounded-lg bg-app-surface/50" />
                      ))}
                    </div>
                  ) : genre.status === "error" ? <RadioLoadError message="Could not load stations for this genre." retry={genre.retry} /> : tagStations.length === 0 ? <p className="text-sm text-white/40">No stations found for this genre.</p> : (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {tagStations.map(s => <StationCard key={s.uuid} station={s} />)}
                    </div>
                  )}
                </>
              ) : tagIndex.status === "loading" ? <p role="status" className="text-sm text-white/40">Loading genres…</p> : tagIndex.status === "error" ? <RadioLoadError message="Could not load genres." retry={tagIndex.retry} /> : tags.length === 0 ? <p className="text-sm text-white/40">No genres available.</p> : (
                <div className="flex flex-wrap gap-2">
                  {tags.map(t => (
                    <button
                      key={t.name}
                      onClick={() => setSelectedTag(t.name)}
                      className="rounded-full bg-app-surface/30 px-4 py-2 text-sm text-white/70 transition-colors hover:bg-app-surface/60 hover:text-white"
                    >
                      {t.name}
                      <span className="ml-1.5 text-xs text-white/30">{t.station_count.toLocaleString()}</span>
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
