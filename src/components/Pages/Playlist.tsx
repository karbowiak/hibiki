import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore, usePlayerStore, useUIStore } from "../../stores"
import { useProviderStore } from "../../stores/providerStore"
import { formatTotalMs } from "../../lib/formatters"
import { useContextMenuStore } from "../../stores/contextMenuStore"
import { useTableSort } from "../../hooks/useTableSort"
import { RichText } from "../RichText"
import { UltraBlur } from "../UltraBlur"
import { useScrollContainer } from "../Page"
import { ALL_COLUMNS, usePlaylistColumns } from "../../hooks/useColumnPicker"
import { TrackTable } from "../shared/TrackTable"

const PLAYLIST_COLUMNS = ALL_COLUMNS


/**
 * Actual pixel height of a single track row.
 * The tallest cell content is the thumbnail at h-10 (40px). Table rows do not
 * stack <td> padding on top of content height the way block elements do.
 */
const ROW_HEIGHT_PX = 40

export function Playlist({ playlistId }: { playlistId: string }) {
  // Granular selectors: changes to playlistItemsCache (background prefetch)
  // do NOT trigger re-renders of this component.
  const { fetchPlaylistItems, fetchMorePlaylistItems, reorderPlaylistItems } = useLibraryStore(useShallow(s => ({
    fetchPlaylistItems: s.fetchPlaylistItems,
    fetchMorePlaylistItems: s.fetchMorePlaylistItems,
    reorderPlaylistItems: s.reorderPlaylistItems,
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
  const provider = useProviderStore(s => s.provider)
  const pageRefreshKey = useUIStore(s => s.pageRefreshKey)
  const scrollContainerRef = useScrollContainer()
  const sentinelRef = useRef<HTMLDivElement>(null)

  const { visible: visibleCols, toggle: toggleCol } = usePlaylistColumns("plex-playlist-columns")

  // In-playlist search
  const [filterQuery, setFilterQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(filterQuery), 150)
    return () => clearTimeout(t)
  }, [filterQuery])

  const filteredItems = useMemo(() => {
    if (!debouncedQuery) return currentPlaylistItems
    const q = debouncedQuery.toLowerCase()
    return currentPlaylistItems.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.artistName.toLowerCase().includes(q) ||
      t.albumName.toLowerCase().includes(q)
    )
  }, [currentPlaylistItems, debouncedQuery])

  type SortCol = "default" | "title" | "artist" | "album" | "year" | "plays" | "popularity" | "label" | "bitrate" | "format" | "added_at" | "rating" | "rated_at" | "duration"
  const { sortCol, sortDir, handleSort } = useTableSort<SortCol>({ resetKey: playlistId })

  const sortedItems = useMemo(() => {
    if (sortCol === "default") return filteredItems
    const items = [...filteredItems]
    items.sort((a, b) => {
      let cmp = 0
      switch (sortCol) {
        case "title":      cmp = a.title.localeCompare(b.title); break
        case "artist":     cmp = a.artistName.localeCompare(b.artistName); break
        case "album":      cmp = a.albumName.localeCompare(b.albumName); break
        case "year":       cmp = (a.albumYear ?? a.year) - (b.albumYear ?? b.year); break
        case "plays":      cmp = a.playCount - b.playCount; break
        case "popularity": cmp = (a.ratingCount ?? 0) - (b.ratingCount ?? 0); break
        case "label":      cmp = (a.parentStudio ?? "").localeCompare(b.parentStudio ?? ""); break
        case "bitrate":    cmp = (a.bitrate ?? 0) - (b.bitrate ?? 0); break
        case "format":     cmp = (a.codec ?? "").localeCompare(b.codec ?? ""); break
        case "added_at":   cmp = (a.addedAt ? +new Date(a.addedAt) : 0) - (b.addedAt ? +new Date(b.addedAt) : 0); break
        case "rating":     cmp = (a.userRating ?? 0) - (b.userRating ?? 0); break
        case "rated_at":   cmp = (a.lastRatedAt ? +new Date(a.lastRatedAt) : 0) - (b.lastRatedAt ? +new Date(b.lastRatedAt) : 0); break
        case "duration":   cmp = a.duration - b.duration; break
      }
      return sortDir === "asc" ? cmp : -cmp
    })
    return items
  }, [filteredItems, sortCol, sortDir])

  useEffect(() => {
    if (playlistId) void fetchPlaylistItems(playlistId)
  }, [playlistId, pageRefreshKey, provider])

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

  // Reorder is only available for non-smart playlists in default sort order with no filter
  const canReorder = !!currentPlaylist && !currentPlaylist.smart && sortCol === "default" && !debouncedQuery

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    if (!provider || !canReorder) return
    const items = currentPlaylistItems
    const movedTrack = items[fromIndex]
    if (!movedTrack?.playlistItemId) return

    const afterIndex = toIndex > fromIndex ? toIndex : toIndex - 1
    const afterTrack = afterIndex >= 0 ? items[afterIndex] : null
    const afterItemId = afterTrack?.playlistItemId ?? "0"

    reorderPlaylistItems(playlistId, fromIndex, toIndex)

    provider.movePlaylistItem(playlistId, movedTrack.playlistItemId, afterItemId).catch(() => {
      void fetchPlaylistItems(playlistId)
    })
  }, [provider, canReorder, currentPlaylistItems, playlistId, reorderPlaylistItems, fetchPlaylistItems])

  if (!currentPlaylist && !isLoading) {
    return <div className="p-8 text-gray-400">Playlist not found.</div>
  }

  if (!currentPlaylist) {
    return <div className="p-8 text-gray-400">Loading…</div>
  }

  const thumbUrl = currentPlaylist.thumbUrl

  const loadedCount = currentPlaylistItems.length
  const totalCount = currentPlaylist.trackCount
  const displayCount = isFullyLoaded ? loadedCount : totalCount
  const totalMs = currentPlaylistItems.reduce((sum, t) => sum + t.duration, 0)

  // URI for server-side play queue — enables full-playlist shuffle regardless of loaded count.
  const playlistUri = currentPlaylist?.providerKey && provider?.buildPlaylistUri
    ? provider.buildPlaylistUri(currentPlaylist.providerKey)
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

                {/* More actions */}
                <button
                  onClick={e => {
                    e.stopPropagation()
                    const rect = e.currentTarget.getBoundingClientRect()
                    useContextMenuStore.getState().show(rect.right, rect.bottom + 4, "playlist", currentPlaylist)
                  }}
                  title="More actions"
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-white/70 hover:text-white hover:bg-black/45 hover:scale-105 active:scale-95 transition-all"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                    <circle cx="3" cy="8" r="1.5" />
                    <circle cx="8" cy="8" r="1.5" />
                    <circle cx="13" cy="8" r="1.5" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Track list */}
      <TrackTable
        tracks={sortedItems}
        visibleCols={visibleCols}
        toggleCol={toggleCol}
        sortCol={sortCol}
        sortDir={sortDir}
        onSort={handleSort}
        onPlay={(track, all) => void playTrack(track, all, currentPlaylist?.title, `/playlist/${playlistId}`)}
        onAddToQueue={addToQueue}
        onPlayRadio={playRadio}
        columns={PLAYLIST_COLUMNS}
        searchPlaceholder="Search in playlist…  ⌘K"
        filterQuery={filterQuery}
        onFilterChange={setFilterQuery}
        defaultResetTitle="Restore playlist order"
        isLoading={isLoading}
        loadedCount={loadedCount}
        emptyMessage="This playlist is empty."
        sentinel={sentinelRef}
        spacerHeight={spacerHeight}
        isFetchingMore={isFetchingMore}
        currentTrackId={currentTrack?.id ?? null}
        playlistId={currentPlaylist.smart ? undefined : playlistId}
        onReorder={canReorder ? handleReorder : undefined}
      />
    </div>
  )
}
