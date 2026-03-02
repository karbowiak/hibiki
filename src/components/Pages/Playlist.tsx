import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore, usePlayerStore, useConnectionStore, buildPlexImageUrl, useUIStore } from "../../stores"
import { buildItemUri, rateItem } from "../../lib/plex"
import { lastfmLoveTrack } from "../../lib/lastfm"
import { useLastfmStore } from "../../stores/lastfmStore"
import { prefetchTrackAudio } from "../../stores/playerStore"
import { useContextMenuStore } from "../../stores/contextMenuStore"
import { RichText } from "../RichText"
import { UltraBlur } from "../UltraBlur"
import { useScrollContainer } from "../Page"

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`
}

function formatTotalMs(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  const hr = Math.floor(totalMin / 60)
  const min = totalMin % 60
  if (hr === 0) return `${min} min`
  return min > 0 ? `${hr} hr ${min} min` : `${hr} hr`
}

function formatDate(value: string | null): string {
  if (!value) return ""
  const num = Number(value)
  const date = isNaN(num) ? new Date(value) : new Date(num * 1000)
  if (isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date)
}

function formatBitrate(kbps: number | null | undefined): string {
  if (!kbps) return ""
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`
}

function keyToId(key: string): number {
  return parseInt(key.split("/").pop() ?? "0", 10)
}

function SortTh({
  col, label, active, dir, onSort, align,
}: {
  col: string
  label: string
  active: string
  dir: "asc" | "desc"
  onSort: (col: string) => void
  align: "left" | "right"
}) {
  const isActive = active === col
  return (
    <th
      className={`p-2 text-${align} cursor-pointer select-none whitespace-nowrap transition-colors hover:text-white ${isActive ? "text-white" : ""}`}
      onClick={() => onSort(col)}
    >
      {label}
      {isActive && (
        <span className="ml-1 text-accent">{dir === "asc" ? "↑" : "↓"}</span>
      )}
    </th>
  )
}

// ---------------------------------------------------------------------------
// Column picker
// ---------------------------------------------------------------------------

const COLUMN_STORAGE_KEY = "plex-playlist-columns"
type ColId = "album" | "year" | "plays" | "popularity" | "label" | "bitrate" | "format" | "added_at"

const ALL_COLUMNS: { id: ColId; label: string; defaultOn: boolean }[] = [
  { id: "album",      label: "Album",               defaultOn: true  },
  { id: "added_at",   label: "Date Added (Library)", defaultOn: true  },
  { id: "year",       label: "Year",                defaultOn: false },
  { id: "plays",      label: "Plays",               defaultOn: false },
  { id: "popularity", label: "Popularity",          defaultOn: false },
  { id: "label",      label: "Label",               defaultOn: false },
  { id: "bitrate",    label: "Bit Rate",            defaultOn: false },
  { id: "format",     label: "Format",              defaultOn: false },
]

function usePlaylistColumns() {
  const [visible, setVisible] = useState<Set<ColId>>(() => {
    try {
      const saved = localStorage.getItem(COLUMN_STORAGE_KEY)
      if (saved) return new Set(JSON.parse(saved) as ColId[])
    } catch {}
    return new Set(ALL_COLUMNS.filter(c => c.defaultOn).map(c => c.id))
  })

  function toggle(id: ColId) {
    setVisible(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify([...next]))
      return next
    })
  }

  return { visible, toggle }
}

function ColumnPicker({ visible, toggle }: { visible: Set<ColId>; toggle: (id: ColId) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open])

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors px-2 py-1 rounded hover:bg-white/10"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
          <path d="M1 3.5A.5.5 0 0 1 1.5 3h13a.5.5 0 0 1 0 1h-13A.5.5 0 0 1 1 3.5zm3 3A.5.5 0 0 1 4.5 6h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm2 3A.5.5 0 0 1 6.5 9h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5z" />
        </svg>
        Columns
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-52 rounded-md bg-app-surface shadow-xl border border-white/10 py-1">
          {ALL_COLUMNS.map(col => (
            <label
              key={col.id}
              className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-white/10 text-sm text-gray-300"
            >
              <input
                type="checkbox"
                checked={visible.has(col.id)}
                onChange={() => toggle(col.id)}
                style={{ accentColor: "var(--accent)" }}
              />
              {col.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Star rating
// ---------------------------------------------------------------------------

function TrackRating({ ratingKey, userRating, artist, track }: {
  ratingKey: number
  userRating: number | null
  artist: string
  track: string
}) {
  const loveThreshold = useLastfmStore(s => s.loveThreshold)
  // Optimistic local override — undefined means "use server value"
  const [local, setLocal] = useState<number | null | undefined>(undefined)
  const display = local !== undefined ? local : userRating
  const filled = Math.round((display ?? 0) / 2)

  function rate(value: number | null) {
    setLocal(value)
    void rateItem(ratingKey, value).catch(() => setLocal(undefined))
    // Sync love/unlove to Last.fm based on the configured threshold (fire-and-forget)
    const plexRating = value ?? 0
    const shouldLove = plexRating >= loveThreshold
    void lastfmLoveTrack(artist, track, shouldLove).catch(() => {})
  }

  return (
    <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
      {[1, 2, 3, 4, 5].map(star => (
        <button
          key={star}
          title={`Rate ${star} star${star > 1 ? "s" : ""}`}
          className={`transition-colors ${filled >= star ? "text-accent" : "text-gray-600 hover:text-accent/70"}`}
          onClick={e => {
            e.stopPropagation()
            // Click the same filled star again → clear rating
            rate(filled === star ? null : star * 2)
          }}
        >
          <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
            <path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z" />
          </svg>
        </button>
      ))}
    </div>
  )
}

/**
 * Actual pixel height of a single track row.
 * The tallest cell content is the thumbnail at h-10 (40px). Table rows do not
 * stack <td> padding on top of content height the way block elements do.
 */
const ROW_HEIGHT_PX = 40

export function Playlist({ playlistId }: { playlistId: number }) {
  // Granular selectors: changes to playlistItemsCache (background prefetch)
  // do NOT trigger re-renders of this component.
  const { fetchPlaylistItems, fetchMorePlaylistItems } = useLibraryStore(useShallow(s => ({
    fetchPlaylistItems: s.fetchPlaylistItems,
    fetchMorePlaylistItems: s.fetchMorePlaylistItems,
  })))
  const currentPlaylist = useLibraryStore(s => s.currentPlaylist)
  const currentPlaylistItems = useLibraryStore(s => s.currentPlaylistItems)
  const isLoading = useLibraryStore(s => s.isLoading)
  const isFetchingMore = useLibraryStore(s => s.isFetchingMore)
  // Subscribe only to this specific playlist's fullness, not the whole record.
  const isFullyLoaded = useLibraryStore(s => s.playlistIsFullyLoaded[playlistId] ?? false)

  const { playTrack, playFromUri, playPlaylist, playRadio, addToQueue, currentTrack } = usePlayerStore(useShallow(s => ({
    playTrack: s.playTrack,
    playFromUri: s.playFromUri,
    playPlaylist: s.playPlaylist,
    playRadio: s.playRadio,
    addToQueue: s.addToQueue,
    currentTrack: s.currentTrack,
  })))
  const showContextMenu = useContextMenuStore(s => s.show)
  const { baseUrl, token, sectionUuid } = useConnectionStore(useShallow(s => ({
    baseUrl: s.baseUrl,
    token: s.token,
    sectionUuid: s.sectionUuid,
  })))
  const pageRefreshKey = useUIStore(s => s.pageRefreshKey)
  const scrollContainerRef = useScrollContainer()
  const sentinelRef = useRef<HTMLDivElement>(null)

  const { visible: visibleCols, toggle: toggleCol } = usePlaylistColumns()

  type SortCol = "default" | "title" | "artist" | "album" | "year" | "plays" | "popularity" | "label" | "bitrate" | "format" | "added_at" | "duration"
  type SortDir = "asc" | "desc"
  const [sortCol, setSortCol] = useState<SortCol>("default")
  const [sortDir, setSortDir] = useState<SortDir>("asc")

  // Reset sort when navigating to a different playlist.
  useEffect(() => {
    setSortCol("default")
    setSortDir("asc")
  }, [playlistId])

  function handleSort(col: string) {
    const c = col as SortCol
    if (sortCol === c) {
      setSortDir(d => d === "asc" ? "desc" : "asc")
    } else {
      setSortCol(c)
      setSortDir("asc")
    }
  }

  const sortedItems = useMemo(() => {
    if (sortCol === "default") return currentPlaylistItems
    const items = [...currentPlaylistItems]
    items.sort((a, b) => {
      let cmp = 0
      switch (sortCol) {
        case "title":      cmp = a.title.localeCompare(b.title); break
        case "artist":     cmp = a.grandparent_title.localeCompare(b.grandparent_title); break
        case "album":      cmp = a.parent_title.localeCompare(b.parent_title); break
        case "year":       cmp = (a.parent_year ?? a.year) - (b.parent_year ?? b.year); break
        case "plays":      cmp = a.view_count - b.view_count; break
        case "popularity": cmp = (a.rating_count ?? 0) - (b.rating_count ?? 0); break
        case "label":      cmp = (a.parent_studio ?? "").localeCompare(b.parent_studio ?? ""); break
        case "bitrate":    cmp = (a.media[0]?.bitrate ?? 0) - (b.media[0]?.bitrate ?? 0); break
        case "format":     cmp = (a.media[0]?.audio_codec ?? "").localeCompare(b.media[0]?.audio_codec ?? ""); break
        case "added_at":   cmp = (a.added_at ? +new Date(a.added_at) : 0) - (b.added_at ? +new Date(b.added_at) : 0); break
        case "duration":   cmp = a.duration - b.duration; break
      }
      return sortDir === "asc" ? cmp : -cmp
    })
    return items
  }, [currentPlaylistItems, sortCol, sortDir])

  useEffect(() => {
    if (playlistId) void fetchPlaylistItems(playlistId)
  }, [playlistId, pageRefreshKey])

  useEffect(() => {
    // Don't attach while a fetch is in progress — re-attaches when it completes,
    // which gives an immediate check for an already-near-bottom sentinel.
    if (isFullyLoaded || isFetchingMore) return
    const scrollEl = scrollContainerRef?.current
    if (!scrollEl) return

    function check() {
      const sentinel = sentinelRef.current
      if (!scrollEl || !sentinel) return
      // Compare the sentinel's position to the scroll container's visible bottom.
      // Using getBoundingClientRect avoids the spacer inflating scrollHeight.
      const sentinelTop = sentinel.getBoundingClientRect().top
      const containerBottom = scrollEl.getBoundingClientRect().bottom
      if (sentinelTop <= containerBottom + 400) {
        void fetchMorePlaylistItems(playlistId)
      }
    }

    scrollEl.addEventListener("scroll", check, { passive: true })
    // Immediate check: handles the case where the initial 50 rows already
    // fill less than the viewport height (sentinel already visible on mount).
    check()

    return () => scrollEl.removeEventListener("scroll", check)
  }, [playlistId, isLoading, isFetchingMore, isFullyLoaded])

  if (!currentPlaylist && !isLoading) {
    return <div className="p-8 text-gray-400">Playlist not found.</div>
  }

  if (!currentPlaylist) {
    return <div className="p-8 text-gray-400">Loading…</div>
  }

  const artPath = currentPlaylist.thumb ?? currentPlaylist.composite
  const thumbUrl = artPath ? buildPlexImageUrl(baseUrl, token, artPath) : null

  const loadedCount = currentPlaylistItems.length
  const totalCount = currentPlaylist.leaf_count
  const displayCount = isFullyLoaded ? loadedCount : totalCount
  const totalMs = currentPlaylistItems.reduce((sum, t) => sum + t.duration, 0)

  // URI for server-side play queue — enables full-playlist shuffle regardless of loaded count.
  const playlistUri = sectionUuid
    ? buildItemUri(sectionUuid, `/library/metadata/${playlistId}`)
    : null

  // Height of the virtual spacer for unloaded tracks.
  // Zero when fully loaded — avoids leftover space when Plex's leaf_count
  // doesn't exactly match the actual number of tracks returned.
  const spacerHeight = isFullyLoaded ? 0 : Math.max(0, (totalCount - loadedCount) * ROW_HEIGHT_PX)

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="relative flex flex-row items-end p-8 overflow-hidden rounded-t-lg hero-overlay">
        <UltraBlur src={thumbUrl} />
        <div className="relative z-10 flex flex-row items-end w-full gap-0">
          {/* Cover art */}
          {thumbUrl ? (
            <img src={thumbUrl} alt="" className="w-60 h-60 rounded-md shadow-2xl object-cover flex-shrink-0" />
          ) : (
            <div className="w-60 h-60 rounded-md bg-app-surface shadow-2xl flex-shrink-0" />
          )}

          {/* Info column */}
          <div className="pl-6 flex flex-col justify-between flex-1 h-60 min-w-0">
            <div className="min-w-0">
              <div className="text-[76px] font-black leading-none drop-shadow truncate">
                {currentPlaylist.title}
              </div>
              {currentPlaylist.summary && (
                <RichText html={currentPlaylist.summary} className="mt-2 max-w-xl text-sm text-gray-300 line-clamp-2" />
              )}
            </div>

            {/* Bottom row: stats + play/shuffle buttons */}
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-400">
                {displayCount} {displayCount === 1 ? "song" : "songs"}
                {totalMs > 0 && <> · {formatTotalMs(totalMs)}</>}
                {!isFullyLoaded && loadedCount > 0 && loadedCount < totalCount && (
                  <span className="ml-1 text-white/30">({loadedCount} loaded)</span>
                )}
              </p>
              <div className="relative z-20 flex items-center gap-3">
                {/* Play in order */}
                <button
                  onClick={() => totalCount > 0 && void playPlaylist(playlistId, totalCount, currentPlaylist.title, `/playlist/${playlistId}`)}
                  disabled={totalCount === 0}
                  title="Play"
                  className="flex h-14 w-14 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-accent hover:bg-black/45 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor">
                    <polygon points="3,2 13,8 3,14" />
                  </svg>
                </button>

                {/* Shuffle */}
                <button
                  onClick={() => playlistUri && void playFromUri(playlistUri, true, currentPlaylist.title, `/playlist/${playlistId}`)}
                  disabled={!playlistUri || totalCount === 0}
                  title="Shuffle play"
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-accent hover:bg-black/45 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                    <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356A2.25 2.25 0 0 1 11.16 4.5h1.949l-1.018 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5zm9.831 8.17l.979 1.167.28.334A3.75 3.75 0 0 0 14.36 14.5h1.64V13h-1.64a2.25 2.25 0 0 1-1.726-.83l-.28-.335-1.733-2.063-.979 1.167 1.18 1.731z" />
                  </svg>
                </button>

                {/* Playlist Radio */}
                <button
                  onClick={() => totalCount > 0 && void playRadio(playlistId, 'playlist', currentPlaylist.title)}
                  disabled={totalCount === 0}
                  title="Playlist Radio — continuous sonically-similar music"
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-accent hover:bg-black/45 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Track list */}
      <div className="px-8 pt-2">
        {/* Toolbar row: column picker floats above the table, right-aligned */}
        <div className="flex items-center justify-end pb-1">
          <ColumnPicker visible={visibleCols} toggle={toggleCol} />
        </div>
        <table className="w-full text-sm text-gray-400">
          <thead className="border-b border-white/10">
            <tr>
              <th
                className="p-2 text-center w-8"
                onClick={() => handleSort("default")}
                title="Restore playlist order"
                style={{ cursor: sortCol !== "default" ? "pointer" : "default" }}
              >#</th>
              <SortTh col="title"      label="Title"               active={sortCol} dir={sortDir} onSort={handleSort} align="left" />
              {visibleCols.has("album")      && <SortTh col="album"      label="Album"               active={sortCol} dir={sortDir} onSort={handleSort} align="left" />}
              {visibleCols.has("year")       && <SortTh col="year"       label="Year"                active={sortCol} dir={sortDir} onSort={handleSort} align="left" />}
              {visibleCols.has("plays")      && <SortTh col="plays"      label="Plays"               active={sortCol} dir={sortDir} onSort={handleSort} align="right" />}
              {visibleCols.has("popularity") && <SortTh col="popularity" label="Popularity"          active={sortCol} dir={sortDir} onSort={handleSort} align="right" />}
              {visibleCols.has("label")      && <SortTh col="label"      label="Label"               active={sortCol} dir={sortDir} onSort={handleSort} align="left" />}
              {visibleCols.has("bitrate")    && <SortTh col="bitrate"    label="Bit Rate"            active={sortCol} dir={sortDir} onSort={handleSort} align="right" />}
              {visibleCols.has("format")     && <SortTh col="format"     label="Format"              active={sortCol} dir={sortDir} onSort={handleSort} align="left" />}
              {visibleCols.has("added_at")   && <SortTh col="added_at"   label="Date Added (Library)" active={sortCol} dir={sortDir} onSort={handleSort} align="left" />}
              <SortTh col="duration"   label="Duration"            active={sortCol} dir={sortDir} onSort={handleSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {isLoading && loadedCount === 0 && Array.from({ length: 8 }).map((_, i) => (
              <tr key={i} className="animate-pulse">
                <td className="p-2 w-8"><div className="h-3 w-3 rounded bg-white/10 mx-auto" /></td>
                <td className="p-2">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-sm bg-white/10 flex-shrink-0" />
                    <div className="space-y-1.5 flex-1">
                      <div className="h-3 rounded bg-white/10 w-2/3" />
                      <div className="h-2.5 rounded bg-white/10 w-1/3" />
                    </div>
                  </div>
                </td>
                {[...visibleCols].map(id => (
                  <td key={id} className="p-2"><div className="h-3 rounded bg-white/10 w-3/4" /></td>
                ))}
                <td className="p-2 text-right"><div className="h-3 rounded bg-white/10 w-10 ml-auto" /></td>
              </tr>
            ))}
            {sortedItems.map((track, idx) => {
              const rawThumb = track.thumb || track.parent_thumb || null
              const trackThumb = rawThumb
                ? buildPlexImageUrl(baseUrl, token, rawThumb)
                : null
              const albumId = keyToId(track.parent_key)
              const artistId = keyToId(track.grandparent_key)
              const isActive = currentTrack?.rating_key === track.rating_key
              return (
                <tr
                  key={track.rating_key}
                  className={`group cursor-pointer rounded ${isActive ? "bg-white/5" : "hover:bg-white/5"}`}
                  onClick={() => void playTrack(track, sortedItems, currentPlaylist?.title, `/playlist/${playlistId}`)}
                  onMouseEnter={() => prefetchTrackAudio(track)}
                  onContextMenu={e => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, "track", track) }}
                >
                  <td className="p-2 text-center w-8">
                    {isActive ? (
                      <>
                        <span className="group-hover:hidden flex items-center justify-center text-accent">
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                            <rect x="1" y="3" width="3" height="10" rx="1"/><rect x="6" y="1" width="3" height="12" rx="1"/><rect x="11" y="5" width="3" height="8" rx="1"/>
                          </svg>
                        </span>
                        <span className="hidden group-hover:flex items-center justify-center text-accent">
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><polygon points="3,2 13,8 3,14" /></svg>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="group-hover:hidden">{idx + 1}</span>
                        <span className="hidden group-hover:flex items-center justify-center">
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                            <polygon points="3,2 13,8 3,14" />
                          </svg>
                        </span>
                      </>
                    )}
                  </td>

                  {/* Title cell: thumbnail + title + subtitle row (artist + fade-in actions) */}
                  <td className="p-2">
                    <div className="flex items-center gap-3">
                      {trackThumb ? (
                        <img className="h-10 w-10 rounded-sm flex-shrink-0 object-cover" src={trackThumb} alt="" />
                      ) : (
                        <div className="h-10 w-10 rounded-sm flex-shrink-0 bg-app-surface" />
                      )}
                      <div className="min-w-0">
                        <div className={`truncate ${isActive ? "text-accent" : "text-white"}`}>{track.title}</div>
                        {/* Subtitle row: artist name + action buttons fade in on hover.
                            Uses opacity instead of display:none/flex so row height never changes. */}
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="truncate shrink min-w-0">
                            {artistId ? (
                              <Link
                                href={`/artist/${artistId}`}
                                className="text-gray-500 hover:text-white hover:underline transition-colors"
                                onClick={e => e.stopPropagation()}
                              >
                                {track.grandparent_title}
                              </Link>
                            ) : (
                              <span className="text-gray-500">{track.grandparent_title}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <button
                              className="flex items-center gap-0.5 text-xs text-gray-400 hover:text-white transition-colors px-1 py-0.5 rounded hover:bg-white/10"
                              title="Add to Queue"
                              onClick={e => { e.stopPropagation(); addToQueue([track]) }}
                            >
                              <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor">
                                <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/>
                              </svg>
                              Queue
                            </button>
                            <button
                              className="flex items-center gap-0.5 text-xs text-gray-400 hover:text-white transition-colors px-1 py-0.5 rounded hover:bg-white/10"
                              title="Track Radio"
                              onClick={e => { e.stopPropagation(); void playRadio(track.rating_key, 'track') }}
                            >
                              <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor">
                                <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                              </svg>
                              Radio
                            </button>
                            <span className="w-px h-3 bg-white/20 mx-0.5" />
                            <TrackRating ratingKey={track.rating_key} userRating={track.user_rating} artist={track.grandparent_title ?? ""} track={track.title} />
                          </div>
                        </div>
                      </div>
                    </div>
                  </td>

                  {visibleCols.has("album") && (
                    <td className="p-2 truncate max-w-[200px]">
                      {albumId ? (
                        <Link
                          href={`/album/${albumId}`}
                          className="hover:text-white hover:underline transition-colors"
                          onClick={e => e.stopPropagation()}
                        >
                          {track.parent_title}
                        </Link>
                      ) : (
                        track.parent_title
                      )}
                    </td>
                  )}
                  {visibleCols.has("year") && (
                    <td className="p-2 tabular-nums">{(track.parent_year ?? track.year) || ""}</td>
                  )}
                  {visibleCols.has("plays") && (
                    <td className="p-2 text-right tabular-nums">{track.view_count || ""}</td>
                  )}
                  {visibleCols.has("popularity") && (
                    <td className="p-2 text-right tabular-nums">{track.rating_count ?? ""}</td>
                  )}
                  {visibleCols.has("label") && (
                    <td className="p-2 truncate max-w-[160px]">{track.parent_studio ?? ""}</td>
                  )}
                  {visibleCols.has("bitrate") && (
                    <td className="p-2 text-right tabular-nums whitespace-nowrap">{formatBitrate(track.media[0]?.bitrate)}</td>
                  )}
                  {visibleCols.has("format") && (
                    <td className="p-2 uppercase text-xs">{track.media[0]?.audio_codec ?? ""}</td>
                  )}
                  {visibleCols.has("added_at") && (
                    <td className="p-2 whitespace-nowrap">{formatDate(track.added_at)}</td>
                  )}
                  <td className="p-2 text-right tabular-nums">{formatMs(track.duration)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* Sentinel marks the boundary between loaded rows and the virtual spacer.
            check() fires when this element is within 400px of the visible area. */}
        <div ref={sentinelRef} />

        {spacerHeight > 0 && (
          <div style={{ height: `${spacerHeight}px` }} className="relative">
            {isFetchingMore && (
              <div className="flex items-center justify-center gap-2 pt-4 text-sm text-gray-500">
                <svg className="animate-spin h-4 w-4 text-white/30" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Loading more…
              </div>
            )}
          </div>
        )}

        {loadedCount === 0 && !isLoading && (
          <div className="py-12 text-center text-sm text-gray-500">
            This playlist is empty.
          </div>
        )}
      </div>
    </div>
  )
}
