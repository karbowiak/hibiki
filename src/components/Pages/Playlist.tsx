import { useEffect, useRef } from "react"
import { Link } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore, usePlayerStore, useConnectionStore, buildPlexImageUrl, useUIStore } from "../../stores"
import { buildItemUri } from "../../lib/plex"
import { prefetchTrackAudio } from "../../stores/playerStore"
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

function keyToId(key: string): number {
  return parseInt(key.split("/").pop() ?? "0", 10)
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

  const { playTrack, playFromUri, playPlaylist } = usePlayerStore(useShallow(s => ({
    playTrack: s.playTrack,
    playFromUri: s.playFromUri,
    playPlaylist: s.playPlaylist,
  })))
  const { baseUrl, token, sectionUuid } = useConnectionStore(useShallow(s => ({
    baseUrl: s.baseUrl,
    token: s.token,
    sectionUuid: s.sectionUuid,
  })))
  const pageRefreshKey = useUIStore(s => s.pageRefreshKey)
  const scrollContainerRef = useScrollContainer()
  const sentinelRef = useRef<HTMLDivElement>(null)

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
      <div className="relative flex flex-row items-end p-8 overflow-hidden rounded-t-lg">
        <UltraBlur src={thumbUrl} />
        <div className="relative z-10 flex flex-row items-end w-full gap-0">
          {/* Cover art */}
          {thumbUrl ? (
            <img src={thumbUrl} alt="" className="w-60 h-60 rounded-md shadow-2xl object-cover flex-shrink-0" />
          ) : (
            <div className="w-60 h-60 rounded-md bg-[#282828] shadow-2xl flex-shrink-0" />
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
              <div className="flex items-center gap-3">
                {/* Shuffle — uses server-side play queue, works for any size */}
                <button
                  onClick={() => playlistUri && void playFromUri(playlistUri, true)}
                  disabled={!playlistUri || totalCount === 0}
                  title="Shuffle play"
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor">
                    <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356A2.25 2.25 0 0 1 11.16 4.5h1.949l-1.018 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5zm9.831 8.17l.979 1.167.28.334A3.75 3.75 0 0 0 14.36 14.5h1.64V13h-1.64a2.25 2.25 0 0 1-1.726-.83l-.28-.335-1.733-2.063-.979 1.167 1.18 1.731z" />
                  </svg>
                </button>

                {/* Play in order — progressive queue loading (100 tracks at a time) */}
                <button
                  onClick={() => totalCount > 0 && void playPlaylist(playlistId, totalCount)}
                  disabled={totalCount === 0}
                  title="Play"
                  className="flex h-14 w-14 items-center justify-center rounded-full bg-[#1db954] text-black shadow-lg hover:bg-[#1ed760] hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor">
                    <polygon points="3,2 13,8 3,14" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Track list */}
      <div className="px-8 pt-4">
        <table className="w-full text-sm text-gray-400">
          <thead className="border-b border-white/10">
            <tr>
              <th className="p-2 text-center w-8">#</th>
              <th className="p-2 text-left">Title</th>
              <th className="p-2 text-left">Album</th>
              <th className="p-2 text-left">Date Added</th>
              <th className="p-2 text-right">Duration</th>
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
                <td className="p-2"><div className="h-3 rounded bg-white/10 w-3/4" /></td>
                <td className="p-2"><div className="h-3 rounded bg-white/10 w-1/2" /></td>
                <td className="p-2 text-right"><div className="h-3 rounded bg-white/10 w-10 ml-auto" /></td>
              </tr>
            ))}
            {currentPlaylistItems.map((track, idx) => {
              const rawThumb = track.thumb || track.parent_thumb || null
              const trackThumb = rawThumb
                ? buildPlexImageUrl(baseUrl, token, rawThumb)
                : null
              const albumId = keyToId(track.parent_key)
              const artistId = keyToId(track.grandparent_key)
              return (
                <tr
                  key={track.rating_key}
                  className="group cursor-pointer hover:bg-white/5 rounded"
                  onClick={() => void playTrack(track, currentPlaylistItems)}
                  onMouseEnter={() => prefetchTrackAudio(track)}
                >
                  <td className="p-2 text-center w-8">
                    <span className="group-hover:hidden">{idx + 1}</span>
                    <span className="hidden group-hover:flex items-center justify-center">
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                        <polygon points="3,2 13,8 3,14" />
                      </svg>
                    </span>
                  </td>
                  <td className="p-2">
                    <div className="flex items-center gap-3">
                      {trackThumb ? (
                        <img className="h-10 w-10 rounded-sm flex-shrink-0 object-cover" src={trackThumb} alt="" />
                      ) : (
                        <div className="h-10 w-10 rounded-sm flex-shrink-0 bg-[#282828]" />
                      )}
                      <div className="min-w-0">
                        <div className="text-white truncate">{track.title}</div>
                        <div className="truncate">
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
                      </div>
                    </div>
                  </td>
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
                  <td className="p-2">{formatDate(track.added_at)}</td>
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
