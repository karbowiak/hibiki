import { DownloadBadge } from "./DownloadBadge"
import { IconDownload } from "@tabler/icons-react"
import { useOfflineStatusStore } from "../../offline/statusStore"
import { ArtworkImage } from "./ArtworkImage"
import { Skeleton } from "./Skeleton"
import { useRef, useEffect, useCallback } from "react"
import { Link } from "wouter"
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { MusicTrack } from "../../types/music"
import type { ColId } from "../../hooks/useColumnPicker"
import { ColumnPicker } from "../../hooks/useColumnPicker"
import { SortTh } from "./SortTh"
import { StarRating } from "./StarRating"
import { FavoriteButton } from "./FavoriteButton"
import { formatMs, formatDate, formatBitrate } from "../../lib/formatters"
import { prefetchTrackAudio } from "../../stores/playerStore"
import { useContextMenu } from "../../hooks/useContextMenu"

import { useTrackDrag } from "../../hooks/useTrackDrag"
import { useVirtualWindow, virtualRef } from "../../hooks/useVirtualWindow"
import type { WindowedCollection } from "../../lib/windowedPages"
import { useScrollContainer } from "../../lib/scrollContainer"

export interface TrackTableProps {
  tracks: MusicTrack[]
  visibleCols: Set<ColId>
  toggleCol: (id: ColId) => void
  sortCol: string
  sortDir: "asc" | "desc"
  onSort: (col: string) => void
  onPlay: (track: MusicTrack, allTracks: MusicTrack[], index?: number) => void
  paged?: WindowedCollection<MusicTrack>
  onAddToQueue: (tracks: MusicTrack[]) => void
  onPlayRadio: (
    id: string,
    type: "track" | "artist" | "album" | "playlist"
  ) => void
  columns: { id: ColId; label: string }[]
  searchPlaceholder: string
  filterQuery: string
  onFilterChange: (q: string) => void
  defaultResetTitle?: string
  isLoading?: boolean
  loadedCount?: number
  emptyMessage?: string
  sentinel?: React.RefObject<HTMLDivElement | null>
  spacerHeight?: number
  isFetchingMore?: boolean
  currentTrackId?: string | null
  /** When set, context menu shows "Remove from playlist" */
  playlistId?: string | null
  /** When set, enables drag-to-reorder within the table. Called with (fromIndex, toIndex). */
  onReorder?: (fromIndex: number, toIndex: number) => void
  /** Compact search results omit a second search toolbar and local filter handler. */
  compact?: boolean
  /** Search follows the current provider's radio capability; existing callers keep their controls. */
  showRadio?: boolean
}

function SortableTrackRow({
  id,
  children,
  className,
  onClick,
  onMouseEnter,
  onContextMenu,
  rowRef,
  index,
}: {
  id: string
  children: React.ReactNode
  className?: string
  onClick?: (e: React.MouseEvent<HTMLTableRowElement>) => void
  onMouseEnter?: (e: React.MouseEvent<HTMLTableRowElement>) => void
  onContextMenu?: (e: React.MouseEvent) => void
  rowRef?: React.RefObject<HTMLTableRowElement | null>
  index?: number
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    animateLayoutChanges: () => false,
  })
  const wasDragging = useRef(false)
  useEffect(() => {
    if (isDragging) wasDragging.current = true
  }, [isDragging])

  return (
    <tr
      aria-rowindex={index === undefined ? undefined : index + 2}
      data-track-index={index}
      ref={(node) => {
        setNodeRef(node)
        if (rowRef) rowRef.current = node
      }}
      style={{
        height: "3.75rem",
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className={`${className ?? ""} ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
      onClick={(e) => {
        if (wasDragging.current) {
          wasDragging.current = false
          return
        }
        onClick?.(e)
      }}
      onMouseEnter={onMouseEnter}
      onContextMenu={onContextMenu}
      {...attributes}
      {...listeners}
    >
      {children}
    </tr>
  )
}

function DownloadStatusHeader() {
  return (
    <th scope="col" className="w-12 p-2 text-center" title="Download status">
      <IconDownload aria-hidden="true" size={16} className="mx-auto" />
      <span className="sr-only">Download status</span>
    </th>
  )
}

function TrackRowCells({
  track,
  idx,
  visibleCols,
  currentTrackId,
  showInlineRating,
  showInlineDownload,
  onPlay,
  onAddToQueue,
  onPlayRadio,
  tracks,
  compact,
  showRadio,
}: {
  track: MusicTrack
  idx: number
  visibleCols: Set<ColId>
  currentTrackId?: string | null
  showInlineRating: boolean
  showInlineDownload: boolean
  onPlay: TrackTableProps["onPlay"]
  onAddToQueue: TrackTableProps["onAddToQueue"]
  onPlayRadio: TrackTableProps["onPlayRadio"]
  tracks: MusicTrack[]
  compact: boolean
  showRadio: boolean
}) {
  const offline = useOfflineStatusStore((state) => state.offlineMode)
  const unavailable =
    offline &&
    !track.mediaInfo?.localAudio &&
    track.mediaInfo?.offlineAvailable !== true
  const isActive = currentTrackId === track.id
  return (
    <>
      <td className="w-8 p-2 text-center">
        <button
          type="button"
          disabled={unavailable}
          title={unavailable ? "Not available offline" : undefined}
          aria-label={`Play ${track.title}`}
          onPointerDown={(e) => e.stopPropagation()}
          aria-current={isActive ? "true" : undefined}
          onClick={(e) => {
            e.stopPropagation()
            onPlay(track, tracks, idx)
          }}
          className={`group/play flex h-7 w-7 items-center justify-center rounded-full hover:bg-hl-menu focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${isActive ? "text-accent" : "text-[var(--text-secondary)]"}`}
        >
          {!compact && (
            <span
              aria-hidden="true"
              className="group-focus-within:hidden group-hover:hidden"
            >
              {isActive ? (
                <svg
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  fill="currentColor"
                >
                  <rect x="1" y="3" width="3" height="10" rx="1" />
                  <rect x="6" y="1" width="3" height="12" rx="1" />
                  <rect x="11" y="5" width="3" height="8" rx="1" />
                </svg>
              ) : (
                idx + 1
              )}
            </span>
          )}
          <svg
            aria-hidden="true"
            className={
              compact ? "" : "hidden group-focus-within:block group-hover:block"
            }
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="currentColor"
          >
            <polygon points="3,2 13,8 3,14" />
          </svg>
        </button>
      </td>

      <td className="p-2">
        <div className="flex items-center gap-3">
          {track.thumbUrl ? (
            <ArtworkImage
              className="h-10 w-10 flex-shrink-0 rounded-sm object-cover"
              src={track.thumbUrl}
              alt=""
            />
          ) : (
            <div className="h-10 w-10 flex-shrink-0 rounded-sm bg-app-surface" />
          )}
          <div className={compact ? "min-w-0 flex-1" : "min-w-0"}>
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={`truncate ${isActive ? "text-accent" : "text-[var(--text-primary)]"}`}
              >
                {track.title}
              </span>
              {showInlineDownload && (
                <DownloadBadge kind="track" id={track.id} />
              )}
            </div>
            <div
              className={`flex min-w-0 items-center gap-2 ${compact ? "flex-wrap" : ""}`}
            >
              {!visibleCols.has("artist") && (
                <div className="min-w-0 shrink truncate">
                  {track.artistId ? (
                    <Link
                      href={`/artist/${track.artistId}`}
                      className="text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {track.artistName}
                    </Link>
                  ) : (
                    <span className="text-[var(--text-muted)]">
                      {track.artistName}
                    </span>
                  )}
                </div>
              )}
              <div
                className={`flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100`}
              >
                <button
                  className="flex items-center gap-0.5 rounded px-1 py-0.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-hl-menu hover:text-[var(--text-primary)]"
                  disabled={unavailable}
                  title={unavailable ? "Not available offline" : "Add to Queue"}
                  onClick={(e) => {
                    e.stopPropagation()
                    onAddToQueue([track])
                  }}
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="10"
                    height="10"
                    fill="currentColor"
                  >
                    <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z" />
                  </svg>
                  Queue
                </button>
                {showRadio && (
                  <button
                    className="flex items-center gap-0.5 rounded px-1 py-0.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-hl-menu hover:text-[var(--text-primary)]"
                    title="Track Radio"
                    onClick={(e) => {
                      e.stopPropagation()
                      void onPlayRadio(track.id, "track")
                    }}
                  >
                    <svg
                      viewBox="0 0 16 16"
                      width="10"
                      height="10"
                      fill="currentColor"
                    >
                      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                    </svg>
                    Radio
                  </button>
                )}
                <FavoriteButton track={track} size={13} />
                {showInlineRating && (
                  <>
                    <span className="mx-0.5 h-3 w-px bg-white/20" />
                    <StarRating
                      itemId={track.id}
                      userRating={track.userRating}
                      artist={track.artistName ?? ""}
                      track={track.title}
                      size={11}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </td>

      {visibleCols.has("artist") && (
        <td className="max-w-[180px] truncate p-2">
          {track.artistId ? (
            <Link
              href={`/artist/${track.artistId}`}
              className="transition-colors hover:text-[var(--text-primary)] hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {track.artistName}
            </Link>
          ) : (
            track.artistName
          )}
        </td>
      )}

      {visibleCols.has("album") && (
        <td className="max-w-[200px] truncate p-2">
          {track.albumId ? (
            <Link
              href={`/album/${track.albumId}`}
              className="transition-colors hover:text-[var(--text-primary)] hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {track.albumName}
            </Link>
          ) : (
            track.albumName
          )}
        </td>
      )}

      {visibleCols.has("year") && (
        <td className="p-2 tabular-nums">
          {(track.albumYear ?? track.year) || ""}
        </td>
      )}
      {visibleCols.has("plays") && (
        <td className="p-2 text-right tabular-nums">{track.playCount || ""}</td>
      )}
      {visibleCols.has("popularity") && (
        <td className="p-2 text-right tabular-nums">
          {track.ratingCount ?? ""}
        </td>
      )}
      {visibleCols.has("label") && (
        <td className="max-w-[160px] truncate p-2">
          {track.parentStudio ?? ""}
        </td>
      )}
      {visibleCols.has("bitrate") && (
        <td className="whitespace-nowrap p-2 text-right tabular-nums">
          {formatBitrate(track.bitrate)}
        </td>
      )}
      {visibleCols.has("format") && (
        <td className="p-2 text-xs uppercase">{track.codec ?? ""}</td>
      )}
      {visibleCols.has("added_at") && (
        <td className="whitespace-nowrap p-2">{formatDate(track.addedAt)}</td>
      )}
      {visibleCols.has("rating") && (
        <td className="p-2">
          <StarRating
            itemId={track.id}
            userRating={track.userRating}
            artist={track.artistName ?? ""}
            track={track.title}
          />
        </td>
      )}
      {visibleCols.has("rated_at") && (
        <td className="whitespace-nowrap p-2">
          {formatDate(track.lastRatedAt ?? null)}
        </td>
      )}
      {visibleCols.has("liked_at") && (
        <td className="whitespace-nowrap p-2">
          {formatDate(track.likedAt ?? null)}
        </td>
      )}
      <td className="p-2 text-right tabular-nums">
        {formatMs(track.duration)}
      </td>
      {visibleCols.has("downloads") && (
        <td className="w-12 p-2 text-center">
          <DownloadBadge kind="track" id={track.id} />
        </td>
      )}
    </>
  )
}

function TrackTableBody({
  tracks,
  isLoading,
  loadedCount,
  visibleCols,
  currentTrackId,
  isCtxTarget,
  ctxMenu,
  onPlay,
  onAddToQueue,
  onPlayRadio,
  showInlineRating,
  showInlineDownload,
  playlistId,
  reorderEnabled,
  trackDrag,
  compact,
  showRadio,
  paged,
}: {
  tracks: MusicTrack[]
  isLoading: boolean
  loadedCount: number
  visibleCols: Set<ColId>
  currentTrackId?: string | null
  isCtxTarget: (id: string) => boolean
  ctxMenu: ReturnType<typeof useContextMenu>["handler"]
  onPlay: TrackTableProps["onPlay"]
  onAddToQueue: TrackTableProps["onAddToQueue"]
  onPlayRadio: TrackTableProps["onPlayRadio"]
  showInlineRating: boolean
  showInlineDownload: boolean
  playlistId?: string | null
  reorderEnabled: boolean
  trackDrag: ReturnType<typeof useTrackDrag>
  compact: boolean
  showRadio: boolean
  paged?: WindowedCollection<MusicTrack>
}) {
  const skeletons =
    isLoading &&
    loadedCount === 0 &&
    Array.from({ length: 8 }).map((_, i) => (
      <tr key={i} aria-hidden="true">
        <td className="w-8 p-2">
          <Skeleton className="mx-auto h-3 w-3" />
        </td>
        <td className="p-2">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 flex-shrink-0 rounded-sm" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
          </div>
        </td>
        {[...visibleCols]
          .filter((id) => id !== "downloads")
          .map((id) => (
            <td key={id} className="p-2">
              <Skeleton className="h-3 w-3/4" />
            </td>
          ))}
        <td className="p-2 text-right">
          <Skeleton className="ml-auto h-3 w-10" />
        </td>
        {visibleCols.has("downloads") && (
          <td className="w-12 p-2">
            <Skeleton className="mx-auto h-4 w-4" />
          </td>
        )}
      </tr>
    ))

  const cellProps = {
    visibleCols,
    currentTrackId,
    showInlineRating,
    showInlineDownload,
    onPlay,
    onAddToQueue,
    onPlayRadio,
    tracks,
    compact,
    showRadio,
  }

  const offline = useOfflineStatusStore((state) => state.offlineMode)
  const count = paged?.total ?? tracks.length
  const window = useVirtualWindow(count, 56, 1, count > 100)
  useEffect(() => {
    paged?.ensureRange(window.start, window.end)
  }, [paged, window.start, window.end])
  const rowOccurrences = new Map<string, number>()
  const trackRows = Array.from(
    { length: Math.max(0, window.end - window.start) },
    (_, index) => {
      const idx = window.start + index
      const track = paged ? paged.getItem(idx) : tracks[idx]
      if (!track)
        return (
          <tr
            key={`loading-${idx}`}
            aria-rowindex={idx + 2}
            data-loading-index={idx}
            ref={
              index === 0
                ? virtualRef<HTMLTableRowElement>(window.measure)
                : undefined
            }
            style={{ height: "3.75rem" }}
          >
            <td className="p-2 text-center text-[var(--text-muted)]">
              {idx + 1}
            </td>
            <td colSpan={visibleCols.size + 2} className="p-2">
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 shrink-0 rounded-sm" />
                <Skeleton className="h-3 w-48" />
              </div>
              <span className="sr-only">Loading song {idx + 1}</span>
            </td>
          </tr>
        )
      const identity = track.playlistItemId
        ? `${track.id}:${track.playlistItemId}`
        : track.id
      const occurrence = rowOccurrences.get(identity) ?? 0
      rowOccurrences.set(identity, occurrence + 1)
      const rowKey = `${identity}:${occurrence}`
      const unavailable =
        offline &&
        !track.mediaInfo?.localAudio &&
        track.mediaInfo?.offlineAvailable !== true
      const isActive = currentTrackId === track.id
      const isContextTarget = isCtxTarget(track.id)
      const rowClass = `group ${unavailable ? "opacity-40 cursor-default" : "cursor-pointer"} rounded ${isActive || isContextTarget ? "bg-hl-row" : "hover:bg-hl-row"}`
      const cells = <TrackRowCells track={track} idx={idx} {...cellProps} />

      if (reorderEnabled) {
        return (
          <SortableTrackRow
            key={rowKey}
            id={String(idx)}
            index={idx}
            rowRef={
              index === 0
                ? virtualRef<HTMLTableRowElement>(window.measure)
                : undefined
            }
            className={rowClass}
            onClick={() => {
              if (!unavailable) onPlay(track, tracks, idx)
            }}
            onMouseEnter={() => {
              if (!unavailable) prefetchTrackAudio(track)
            }}
            onContextMenu={ctxMenu("track", track, playlistId)}
          >
            {cells}
          </SortableTrackRow>
        )
      }

      return (
        <tr
          ref={
            index === 0
              ? virtualRef<HTMLTableRowElement>(window.measure)
              : undefined
          }
          style={{ height: "3.75rem" }}
          aria-rowindex={idx + 2}
          data-track-index={idx}
          key={rowKey}
          className={rowClass}
          onClick={() => {
            if (!unavailable) onPlay(track, tracks, idx)
          }}
          onMouseEnter={() => {
            if (!unavailable) prefetchTrackAudio(track)
          }}
          onContextMenu={ctxMenu("track", track, playlistId)}
          onPointerDown={(e) =>
            trackDrag.onPointerDown(e, {
              type: "track",
              ids: [track.id],
              label: track.title,
              tracks: [track],
            })
          }
          onPointerMove={trackDrag.onPointerMove}
          onPointerUp={trackDrag.onPointerUp}
        >
          {cells}
        </tr>
      )
    }
  )

  const body = (
    <tbody
      ref={virtualRef<HTMLTableSectionElement>(window.host)}
      style={{ overflowAnchor: "none" }}
    >
      {skeletons}
      {window.before > 0 && (
        <tr aria-hidden="true">
          <td
            colSpan={visibleCols.size + 3}
            style={{ height: window.before, padding: 0, border: 0 }}
          />
        </tr>
      )}
      {trackRows}
      {window.after > 0 && (
        <tr aria-hidden="true">
          <td
            colSpan={visibleCols.size + 3}
            style={{ height: window.after, padding: 0, border: 0 }}
          />
        </tr>
      )}
    </tbody>
  )
  return reorderEnabled ? (
    <SortableContext
      items={Array.from(
        { length: Math.max(0, window.end - window.start) },
        (_, i) => String(window.start + i)
      )}
      strategy={verticalListSortingStrategy}
    >
      {body}
    </SortableContext>
  ) : (
    body
  )
}

export function TrackTable({
  tracks,
  visibleCols,
  toggleCol,
  sortCol,
  sortDir,
  onSort,
  onPlay,
  onAddToQueue,
  onPlayRadio,
  columns,
  searchPlaceholder,
  filterQuery,
  onFilterChange,
  defaultResetTitle = "Restore default order",
  isLoading = false,
  loadedCount = 0,
  emptyMessage = "No tracks.",
  sentinel,
  spacerHeight = 0,
  isFetchingMore = false,
  currentTrackId,
  playlistId,
  onReorder,
  compact = false,
  showRadio = true,
  paged,
}: TrackTableProps) {
  const { handler: ctxMenu, isTarget: isCtxTarget } = useContextMenu()
  const trackDrag = useTrackDrag()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const pageScroll = useScrollContainer()
  const previousQuery = useRef([filterQuery, sortCol, sortDir])
  useEffect(() => {
    const next = [filterQuery, sortCol, sortDir]
    if (
      next.some((value, index) => value !== previousQuery.current[index]) &&
      pageScroll?.current
    )
      pageScroll.current.scrollTop = 0
    previousQuery.current = next
  }, [filterQuery, sortCol, sortDir, pageScroll])

  // dnd-kit for playlist reorder
  const reorderEnabled = !!onReorder
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id || !onReorder) return
      const fromIndex = Number(active.id)
      const toIndex = Number(over.id)
      if (!isNaN(fromIndex) && !isNaN(toIndex)) {
        onReorder(fromIndex, toIndex)
      }
    },
    [onReorder]
  )

  // Whether to show inline StarRating in the title cell action buttons.
  // If the columns array offers a "rating" column, the parent renders it as a table column instead.
  const showInlineRating = !compact && !columns.some((c) => c.id === "rating")
  const showInlineDownload =
    !columns.some((c) => c.id === "downloads") && !visibleCols.has("downloads")
  const fixedColumns = !compact && (
    <colgroup>
      <col style={{ width: 48 }} />
      <col />
      {[...visibleCols]
        .filter((id) => id !== "downloads")
        .map((id) => (
          <col
            key={id}
            style={{
              width:
                id === "album"
                  ? 220
                  : id === "artist"
                    ? 180
                    : id === "rating"
                      ? 110
                      : id.endsWith("_at")
                        ? 170
                        : 110,
            }}
          />
        ))}
      <col style={{ width: 88 }} />
      {visibleCols.has("downloads") && <col style={{ width: 48 }} />}
    </colgroup>
  )

  // Escape clears this filter; app-wide search owns Cmd/Ctrl+K.
  useEffect(() => {
    if (compact) return
    function onKeyDown(e: KeyboardEvent) {
      if (
        e.key === "Escape" &&
        document.activeElement === searchInputRef.current
      ) {
        onFilterChange("")
        searchInputRef.current?.blur()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onFilterChange, compact])

  return (
    <div className={compact ? "min-w-0" : "min-w-0 px-8 pt-2"}>
      {/* Toolbar row: search + column picker */}
      {!compact && (
        <div className="flex items-center justify-between pb-1">
          <div className="relative">
            <svg
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="currentColor"
            >
              <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85zm-5.242.156a5 5 0 1 1 0-10 5 5 0 0 1 0 10z" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              value={filterQuery}
              onChange={(e) => onFilterChange(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="w-56 rounded border border-white/10 bg-white/5 py-1 pl-7 pr-2 text-sm text-gray-300 transition-colors placeholder:text-gray-600 focus:border-accent/50 focus:bg-white/[0.07] focus:outline-none"
            />
          </div>
          <ColumnPicker
            visible={visibleCols}
            toggle={toggleCol}
            columns={columns}
          />
        </div>
      )}

      <div
        className={
          compact
            ? "min-w-0"
            : "track-table-scroll relative max-w-full overflow-x-auto"
        }
        data-keyboard-scroll={compact ? undefined : "true"}
        role={compact ? undefined : "region"}
        aria-label={compact ? undefined : "Song table"}
        tabIndex={compact ? undefined : 0}
        onKeyDown={(event) => {
          if (
            event.target === event.currentTarget &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            (event.key === "ArrowLeft" || event.key === "ArrowRight")
          ) {
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.scrollLeft +=
              event.key === "ArrowRight" ? 80 : -80
          }
        }}
      >
        {reorderEnabled ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <table
              className="w-full table-fixed text-sm text-[var(--text-secondary)]"
              aria-rowcount={(paged?.total ?? tracks.length) + 1}
              style={{ minWidth: 400 + visibleCols.size * 135 }}
            >
              {fixedColumns}
              <thead className="border-b border-white/10">
                <tr>
                  <th
                    className="w-8 p-2 text-center"
                    onClick={() => onSort("default")}
                    title={defaultResetTitle}
                    style={{
                      cursor: sortCol !== "default" ? "pointer" : "default",
                    }}
                  >
                    #
                  </th>
                  <SortTh
                    col="title"
                    label="Title"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="left"
                  />
                  {visibleCols.has("artist") && (
                    <SortTh
                      col="artist"
                      label="Artist"
                      active={sortCol}
                      dir={sortDir}
                      onSort={onSort}
                      align="left"
                    />
                  )}
                  {visibleCols.has("album") && (
                    <SortTh
                      col="album"
                      label="Album"
                      active={sortCol}
                      dir={sortDir}
                      onSort={onSort}
                      align="left"
                    />
                  )}
                  {visibleCols.has("year") && (
                    <SortTh
                      col="year"
                      label="Year"
                      active={sortCol}
                      dir={sortDir}
                      onSort={onSort}
                      align="left"
                    />
                  )}
                  {visibleCols.has("plays") && (
                    <SortTh
                      col="plays"
                      label="Plays"
                      active={sortCol}
                      dir={sortDir}
                      onSort={onSort}
                      align="right"
                    />
                  )}
                  {visibleCols.has("popularity") && (
                    <SortTh
                      col="popularity"
                      label="Popularity"
                      active={sortCol}
                      dir={sortDir}
                      onSort={onSort}
                      align="right"
                    />
                  )}
                  {visibleCols.has("label") && (
                    <SortTh
                      col="label"
                      label="Label"
                      active={sortCol}
                      dir={sortDir}
                      onSort={onSort}
                      align="left"
                    />
                  )}
                  {visibleCols.has("bitrate") && (
                    <SortTh
                      col="bitrate"
                      label="Bit Rate"
                      active={sortCol}
                      dir={sortDir}
                      onSort={onSort}
                      align="right"
                    />
                  )}
                  {visibleCols.has("format") && (
                    <SortTh
                      col="format"
                      label="Format"
                      active={sortCol}
                      dir={sortDir}
                      onSort={onSort}
                      align="left"
                    />
                  )}
                  {visibleCols.has("added_at") && (
                    <SortTh
                      col="added_at"
                      label="Date Added (Library)"
                      active={sortCol}
                      dir={sortDir}
                      onSort={onSort}
                      align="left"
                    />
                  )}
                  {visibleCols.has("rating") && (
                    <SortTh
                      col="rating"
                      label="Rating"
                      active={sortCol}
                      dir={sortDir}
                      onSort={onSort}
                      align="left"
                    />
                  )}
                  {visibleCols.has("rated_at") && (
                    <SortTh
                      col="rated_at"
                      label="Date Rated"
                      active={sortCol}
                      dir={sortDir}
                      onSort={onSort}
                      align="left"
                    />
                  )}
                  {visibleCols.has("liked_at") && (
                    <SortTh
                      col="liked_at"
                      label="Date Liked"
                      active={sortCol}
                      dir={sortDir}
                      onSort={onSort}
                      align="left"
                    />
                  )}
                  <SortTh
                    col="duration"
                    label="Duration"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="right"
                  />
                  {visibleCols.has("downloads") && <DownloadStatusHeader />}
                </tr>
              </thead>
              <TrackTableBody
                tracks={tracks}
                isLoading={isLoading}
                loadedCount={loadedCount}
                visibleCols={visibleCols}
                currentTrackId={currentTrackId}
                isCtxTarget={isCtxTarget}
                ctxMenu={ctxMenu}
                onPlay={onPlay}
                onAddToQueue={onAddToQueue}
                onPlayRadio={onPlayRadio}
                showInlineRating={showInlineRating}
                showInlineDownload={showInlineDownload}
                playlistId={playlistId}
                reorderEnabled={reorderEnabled}
                trackDrag={trackDrag}
                compact={compact}
                showRadio={showRadio}
                paged={paged}
              />
            </table>
          </DndContext>
        ) : (
          <table
            className={
              compact
                ? "w-full table-fixed text-sm text-[var(--text-secondary)]"
                : "w-full table-fixed text-sm text-[var(--text-secondary)]"
            }
            aria-rowcount={(paged?.total ?? tracks.length) + 1}
            style={
              compact ? undefined : { minWidth: 400 + visibleCols.size * 135 }
            }
          >
            {fixedColumns}
            {compact && (
              <colgroup>
                <col style={{ width: 44 }} />
                <col />
                {[...visibleCols]
                  .filter((id) => id !== "downloads")
                  .map((id) => (
                    <col key={id} style={{ width: "30%" }} />
                  ))}
                <col style={{ width: 76 }} />
                {visibleCols.has("downloads") && <col style={{ width: 48 }} />}
              </colgroup>
            )}
            <thead className="border-b border-white/10">
              <tr>
                <th
                  className="w-8 p-2 text-center"
                  onClick={() => onSort("default")}
                  title={defaultResetTitle}
                  style={{
                    cursor: sortCol !== "default" ? "pointer" : "default",
                  }}
                >
                  #
                </th>
                <SortTh
                  col="title"
                  label="Title"
                  active={sortCol}
                  dir={sortDir}
                  onSort={onSort}
                  align="left"
                />
                {visibleCols.has("artist") && (
                  <SortTh
                    col="artist"
                    label="Artist"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="left"
                  />
                )}
                {visibleCols.has("album") && (
                  <SortTh
                    col="album"
                    label="Album"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="left"
                  />
                )}
                {visibleCols.has("year") && (
                  <SortTh
                    col="year"
                    label="Year"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="left"
                  />
                )}
                {visibleCols.has("plays") && (
                  <SortTh
                    col="plays"
                    label="Plays"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="right"
                  />
                )}
                {visibleCols.has("popularity") && (
                  <SortTh
                    col="popularity"
                    label="Popularity"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="right"
                  />
                )}
                {visibleCols.has("label") && (
                  <SortTh
                    col="label"
                    label="Label"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="left"
                  />
                )}
                {visibleCols.has("bitrate") && (
                  <SortTh
                    col="bitrate"
                    label="Bit Rate"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="right"
                  />
                )}
                {visibleCols.has("format") && (
                  <SortTh
                    col="format"
                    label="Format"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="left"
                  />
                )}
                {visibleCols.has("added_at") && (
                  <SortTh
                    col="added_at"
                    label="Date Added (Library)"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="left"
                  />
                )}
                {visibleCols.has("rating") && (
                  <SortTh
                    col="rating"
                    label="Rating"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="left"
                  />
                )}
                {visibleCols.has("rated_at") && (
                  <SortTh
                    col="rated_at"
                    label="Date Rated"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="left"
                  />
                )}
                {visibleCols.has("liked_at") && (
                  <SortTh
                    col="liked_at"
                    label="Date Liked"
                    active={sortCol}
                    dir={sortDir}
                    onSort={onSort}
                    align="left"
                  />
                )}
                <SortTh
                  col="duration"
                  label="Duration"
                  active={sortCol}
                  dir={sortDir}
                  onSort={onSort}
                  align="right"
                />
                {visibleCols.has("downloads") && <DownloadStatusHeader />}
              </tr>
            </thead>
            <TrackTableBody
              tracks={tracks}
              isLoading={isLoading}
              loadedCount={loadedCount}
              visibleCols={visibleCols}
              currentTrackId={currentTrackId}
              isCtxTarget={isCtxTarget}
              ctxMenu={ctxMenu}
              onPlay={onPlay}
              onAddToQueue={onAddToQueue}
              onPlayRadio={onPlayRadio}
              showInlineRating={showInlineRating}
              showInlineDownload={showInlineDownload}
              playlistId={playlistId}
              reorderEnabled={false}
              trackDrag={trackDrag}
              compact={compact}
              showRadio={showRadio}
              paged={paged}
            />
          </table>
        )}
      </div>

      {/* Sentinel + virtual spacer for infinite scroll */}
      {sentinel && <div ref={sentinel} />}
      {sentinel && spacerHeight > 0 && (
        <div style={{ height: `${spacerHeight}px` }} className="relative">
          {isFetchingMore && (
            <div className="flex items-center justify-center gap-2 pt-4 text-sm text-[var(--text-muted)]">
              <svg
                className="h-4 w-4 animate-spin text-white/30"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v8H4z"
                />
              </svg>
              Loading more…
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {(paged?.total ?? tracks.length) === 0 &&
        !isLoading &&
        !paged?.error &&
        !paged?.loading && (
          <div className="py-12 text-center text-sm text-[var(--text-muted)]">
            {emptyMessage}
          </div>
        )}
      {paged?.error && (
        <div role="alert" className="py-4 text-sm text-[var(--text-secondary)]">
          {paged.error}{" "}
          <button className="media-secondary ml-3" onClick={paged.retry}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
