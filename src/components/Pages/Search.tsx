import { deduplicateAlbumItems } from "../../lib/dedup"
import { useUIStore } from "../../stores/uiStore"
import { Link } from "wouter"
import "../../styles/discovery.css"
import { useEffect, useMemo, useState } from "react"
import { useShallow } from "zustand/shallow"
import { useSearchStore } from "../../stores"
import {
  getRecentSearches,
  clearRecentSearches,
} from "../../lib/recentSearches"
import type { MusicItem, MusicTrack } from "../../types/music"
import { MediaCard } from "../MediaCard"
import { MediaGrid } from "../shared/MediaGrid"
import { prefetchArtist, prefetchAlbum } from "../../stores/metadataCache"
import { usePlayerStore } from "../../stores/playerStore"
import { useContextMenu } from "../../hooks/useContextMenu"
import { makeDragPayload } from "./Home"
import { SearchDiscovery } from "./SearchDiscovery"
import { TrackTable } from "../shared/TrackTable"
import { useCapability } from "../../hooks/useCapability"
import type { ColId } from "../../hooks/useColumnPicker"

type MediaType = "artist" | "album" | "track" | "playlist"

const GROUP_ORDER: MediaType[] = ["artist", "album", "track", "playlist"]
const GROUP_LABELS: Record<MediaType, string> = {
  artist: "Artists",
  album: "Albums",
  track: "Tracks",
  playlist: "Playlists",
}

const PAGE_SIZE: Record<MediaType, number> = {
  artist: 24,
  album: 24,
  track: 50,
  playlist: 24,
}
const TRACK_COLUMNS: { id: ColId; label: string }[] = [
  { id: "album", label: "Album" },
]
const VISIBLE_TRACK_COLUMNS = new Set<ColId>(["album"])
type SearchView = {
  results: MusicItem[]
  query: string
  filter: MediaType | "all"
  limits: Record<MediaType, number>
  sortCol: string
  sortDir: "asc" | "desc"
}
function newView(results: MusicItem[], query: string): SearchView {
  return {
    results,
    query,
    filter: "all",
    limits: { ...PAGE_SIZE },
    sortCol: "default",
    sortDir: "asc",
  }
}

function groupByType(results: MusicItem[]) {
  const groups: Record<MediaType, MusicItem[]> = {
    artist: [],
    album: [],
    track: [],
    playlist: [],
  }
  for (const item of results) {
    if (item.type in groups) groups[item.type as MediaType].push(item)
  }
  return groups
}

function getInfo(item: MusicItem) {
  switch (item.type) {
    case "artist":
      return {
        title: item.title,
        desc: "Artist",
        thumb: item.thumbUrl,
        isArtist: true,
        href: `/artist/${item.id}`,
        id: item.id,
        itemType: "artist" as const,
        artistName: item.title,
        albumName: null as string | null,
      }
    case "album":
      return {
        title: item.title,
        desc: item.artistName,
        thumb: item.thumbUrl,
        isArtist: false,
        href: `/album/${item.id}`,
        id: item.id,
        itemType: "album" as const,
        artistName: item.artistName,
        albumName: item.title,
      }
    case "track":
      return {
        title: item.title,
        desc: `${item.artistName} · ${item.albumName}`,
        thumb: item.thumbUrl,
        isArtist: false,
        href: null,
        id: item.id,
        itemType: "track" as const,
      }
    case "playlist":
      return {
        title: item.title,
        desc: "Playlist",
        thumb: item.thumbUrl,
        isArtist: false,
        href: `/playlist/${item.id}`,
        id: item.id,
        itemType: "playlist" as const,
      }
    default:
      return null
  }
}

export function Search() {
  const { results, isSearching, error, query, search } = useSearchStore(
    useShallow((s) => ({
      results: s.results,
      isSearching: s.isSearching,
      error: s.error,
      query: s.query,
      search: s.search,
    }))
  )
  const { playTrack, addToQueue, playRadio, currentTrack } = usePlayerStore(
    useShallow((s) => ({
      playTrack: s.playTrack,
      addToQueue: s.addToQueue,
      playRadio: s.playRadio,
      currentTrack: s.currentTrack,
    }))
  )
  const hasRadio = useCapability("radio")
  const { handler: ctxMenu } = useContextMenu()

  const [historyError, setHistoryError] = useState<string | null>(null)
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    getRecentSearches()
  )

  // Refresh the list whenever the query is cleared so newly-recorded searches appear
  useEffect(() => {
    if (!query.trim()) setRecentSearches(getRecentSearches())
  }, [query])

  const showResults = query.trim().length > 0
  const shouldDeduplicate=useUIStore(s=>s.deduplicateAlbums)
  const groups = useMemo(() => groupByType(shouldDeduplicate ? deduplicateAlbumItems(results) : results), [results,shouldDeduplicate])
  const [storedView, setView] = useState(() => newView(results, query))
  // Scope local presentation to the actual result snapshot, including account
  // switches that reuse the same query text. No retired filter/page hides new data.
  const view =
    storedView.results === results && storedView.query === query
      ? storedView
      : newView(results, query)
  const updateView = (change: (current: SearchView) => SearchView) =>
    setView((current) =>
      change(
        current.results === results && current.query === query
          ? current
          : newView(results, query)
      )
    )
  const tracks = useMemo(() => {
    const source = groups.track as (MusicTrack & { type: "track" })[]
    if (view.sortCol === "default") return source
    return [...source].sort((a, b) => {
      const compared =
        view.sortCol === "duration"
          ? a.duration - b.duration
          : view.sortCol === "album"
            ? a.albumName.localeCompare(b.albumName)
            : a.title.localeCompare(b.title)
      return view.sortDir === "asc" ? compared : -compared
    })
  }, [groups, view.sortCol, view.sortDir])
  const total = GROUP_ORDER.reduce((sum, type) => sum + groups[type].length, 0)

  return (
    <div className="min-w-0 pb-12 text-(--text-primary)">
      <header className={showResults ? "mb-6" : "discovery-command-head mb-6"}>
        <h1
          className={
            showResults ? "wrap-break-word text-3xl font-bold" : "discovery-title"
          }
        >
          {showResults ? `Results for “${query.trim()}”` : "Search"}
        </h1>
        <p className="mt-2 text-sm text-(--text-secondary)">
          {showResults
            ? isSearching
              ? "Searching your library…"
              : error
                ? "Search could not be completed."
                : `${total} ${total === 1 ? "result" : "results"} in your library`
            : "Pick up where you left off, or find your next favorite."}
        </p>
      </header>
      {showResults ? (
        <div className="space-y-6">
          {isSearching && (
            <p role="status" className="text-sm text-(--text-secondary)">
              Searching…
            </p>
          )}
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-400/30 bg-red-400/5 p-4 text-sm text-(--text-primary)"
            >
              <p>Search failed: {error}</p>
              <button
                onClick={() => void search(query)}
                className="mt-3 rounded-full border border-white/20 px-4 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                Try again
              </button>
            </div>
          )}
          {!isSearching && !error && total === 0 && (
            <p className="text-sm text-(--text-secondary)">
              No results for “{query.trim()}”. Try another artist, album, or
              track name.
            </p>
          )}
          {total > 0 && (
            <div
              role="group"
              aria-label="Filter search results"
              className="flex flex-wrap gap-2"
            >
              {(["all", ...GROUP_ORDER] as const).map((type) => {
                const count = type === "all" ? total : groups[type].length
                return (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={view.filter === type}
                    disabled={count === 0}
                    onClick={() =>
                      updateView((current) => ({ ...current, filter: type }))
                    }
                    className={`rounded-full px-4 py-1.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 ${view.filter === type ? "bg-accent-tint-strong text-accent" : "bg-app-surface text-(--text-secondary) hover:bg-app-surface-hover"}`}
                  >
                    {type === "all" ? "All" : GROUP_LABELS[type]}{" "}
                    <span className="ml-1 tabular-nums">{count}</span>
                  </button>
                )
              })}
            </div>
          )}
          {GROUP_ORDER.filter(
            (type) => view.filter === "all" || view.filter === type
          ).map((type) => {
            const items = groups[type]
            if (!items.length) return null
            const limit = view.limits[type]
            const visible = Math.min(limit, items.length)
            return (
              <section key={type} aria-labelledby={`search-${type}-heading`}>
                <h2
                  id={`search-${type}-heading`}
                  className="mb-3 text-xl font-bold"
                >
                  {GROUP_LABELS[type]}{" "}
                  <span className="ml-2 text-sm font-normal tabular-nums text-(--text-secondary)">
                    {items.length}
                  </span>
                </h2>
                {type === "track" ? (
                  <TrackTable
                    compact
                    showRadio={hasRadio}
                    tracks={tracks.slice(0, limit)}
                    currentTrackId={currentTrack?.id ?? null}
                    visibleCols={VISIBLE_TRACK_COLUMNS}
                    toggleCol={() => {}}
                    columns={TRACK_COLUMNS}
                    sortCol={view.sortCol}
                    sortDir={view.sortDir}
                    onSort={(col) =>
                      updateView((current) => ({
                        ...current,
                        sortCol: col,
                        sortDir:
                          current.sortCol === col && current.sortDir === "asc"
                            ? "desc"
                            : "asc",
                      }))
                    }
                    onPlay={(track) =>
                      void playTrack(
                        track,
                        tracks,
                        `Search: ${query.trim()}`,
                        "/search"
                      )
                    }
                    onAddToQueue={addToQueue}
                    onPlayRadio={(id, kind) => void playRadio(id, kind)}
                    searchPlaceholder=""
                    filterQuery=""
                    onFilterChange={() => {}}
                    defaultResetTitle="Restore search result order"
                  />
                ) : (
                  <MediaGrid gap={3}>
                    {items.slice(0, limit).map((item, index) => {
                      const info = getInfo(item)
                      if (!info) return null
                      const prefetch =
                        info.itemType === "artist"
                          ? () => prefetchArtist(info.id)
                          : info.itemType === "album"
                            ? () => prefetchAlbum(info.id)
                            : undefined
                      const onContextMenu =
                        item.type === "artist" ||
                        item.type === "album" ||
                        item.type === "playlist"
                          ? ctxMenu(item.type, item)
                          : undefined
                      return (
                        <MediaCard
                          key={`${info.id}-${index}`}
                          title={info.title}
                          desc={info.desc}
                          thumb={info.thumb}
                          isArtist={info.isArtist}
                          href={info.href ?? undefined}
                          prefetch={prefetch}
                          onContextMenu={onContextMenu}
                          dragPayload={makeDragPayload(item)}
                          artistName={
                            "artistName" in info ? info.artistName : undefined
                          }
                          albumName={
                            "albumName" in info ? info.albumName : undefined
                          }
                        />
                      )
                    })}
                  </MediaGrid>
                )}
                {visible < items.length && (
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() =>
                        updateView((current) => ({
                          ...current,
                          limits: {
                            ...current.limits,
                            [type]: current.limits[type] + PAGE_SIZE[type],
                          },
                        }))
                      }
                      className="rounded-full bg-app-surface px-4 py-2 text-sm font-medium hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      Show more {GROUP_LABELS[type].toLowerCase()} (
                      {Math.min(PAGE_SIZE[type], items.length - visible)})
                    </button>
                    <span className="text-xs tabular-nums text-(--text-secondary)">
                      Showing {visible} of {items.length}
                    </span>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      ) : (
        <div className="space-y-4">
          <nav aria-label="Search quick actions" className="discovery-tools">
            <Link href="/library" className="discovery-pill">
              Browse Library
            </Link>
            <Link href="/collection/tracks" className="discovery-pill">
              Liked Songs
            </Link>
            <Link href="/collection/playlists" className="discovery-pill">
              Your Playlists
            </Link>
          </nav>
          {historyError && (
            <p role="alert" className="mb-3 text-sm text-red-400">
              {historyError}
            </p>
          )}
          {recentSearches.length > 0 ? (
            <>
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-(--text-secondary)">
                  Recent searches
                </span>
                <button
                  onClick={() => {
                    if (clearRecentSearches()) {
                      setRecentSearches([])
                      setHistoryError(null)
                    } else
                      setHistoryError(
                        "Could not clear recent searches. Try again."
                      )
                  }}
                  className="text-xs text-(--text-muted) transition-colors hover:text-(--text-primary)"
                >
                  Clear
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {recentSearches.map((q) => (
                  <button
                    key={q}
                    onClick={() => void search(q)}
                    className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-(--text-secondary) transition-colors hover:border-accent/30 hover:bg-hl-menu hover:text-(--text-primary)"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="text-sm text-(--text-muted)">
              Type something to search your library.
            </div>
          )}
          <SearchDiscovery />
        </div>
      )}
    </div>
  )
}
