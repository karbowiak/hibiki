import { ArtistCredits } from "./ArtistCredits"
import { useFavoritesStore } from "../../stores/favoritesStore"
import { useProviderStore } from "../../stores/providerStore"
import { DownloadBadge } from "./DownloadBadge"
import { IconDownload } from "@tabler/icons-react"
import { useOfflineStatusStore } from "../../offline/statusStore"
import { ArtworkImage } from "./ArtworkImage"
import { Skeleton } from "./Skeleton"
import { useRef, useEffect, useCallback } from "react"
import { MusicEntityLink } from "./MusicEntityLink"
import { trackEntity } from "../../lib/musicLinks"
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
import { HeroRating } from "../HeroRating"
import "../../styles/trackRows.css"
import { TrackRowActions } from "./TrackRowActions"
import { MusicSourceBadge, trackMusicSource } from "./MusicSource"
import { formatMs, formatDate, formatBitrate } from "../../lib/formatters"
import { prefetchTrackAudio } from "../../stores/playerStore"
import { useContextMenu } from "../../hooks/useContextMenu"

import { useTrackDrag } from "../../hooks/useTrackDrag"
import { useVirtualWindow, virtualRef } from "../../hooks/useVirtualWindow"
import type { WindowedCollection } from "../../lib/windowedPages"
import { useScrollContainer } from "../../lib/scrollContainer"

const TRACK_DATA_COLUMNS: {
  id: ColId
  label: string
  width: number
  align?: "left" | "right"
}[] = [
  { id: "artist", label: "Artist", width: 180 },
  { id: "album", label: "Album", width: 220 },
  { id: "year", label: "Year", width: 110 },
  { id: "plays", label: "Plays", width: 110, align: "right" },
  { id: "views", label: "Views", width: 110, align: "right" },
  { id: "popularity", label: "Popularity", width: 110, align: "right" },
  { id: "label", label: "Label", width: 160 },
  { id: "bitrate", label: "Bit Rate", width: 110, align: "right" },
  { id: "format", label: "Format", width: 110 },
  { id: "added_at", label: "Date Added (Library)", width: 170 },
  { id: "rated_at", label: "Date Rated", width: 170 },
  { id: "liked_at", label: "Date Liked", width: 170 },
]

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
  onRemoveTrack?: (track: MusicTrack) => Promise<void>
  /** Detail pages share these rows without a collection toolbar. */
  presentation?: "album" | "artist"
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
  presentation,
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
  presentation?: "album" | "artist"
  showInlineDownload: boolean
  onPlay: TrackTableProps["onPlay"]
  onAddToQueue: TrackTableProps["onAddToQueue"]
  onPlayRadio: TrackTableProps["onPlayRadio"]
  tracks: MusicTrack[]
  compact: boolean
  showRadio: boolean
}) {
  const provider = useProviderStore((state) => state.provider)
  const ratingDate = useFavoritesStore((state) =>
    state.provider === provider && state.session === provider?.playbackSession
      ? state.ratingsByTrackId.get(track.id)?.manual?.changedAt
      : undefined
  )
  const offline = useOfflineStatusStore((state) => state.offlineMode)
  const unavailable =
    offline &&
    !track.mediaInfo?.localAudio &&
    track.mediaInfo?.offlineAvailable !== true
  const isActive = currentTrackId === track.id
  const showArtist = !visibleCols.has("artist") && (presentation !== "album" ||
    !!(track.originalTitle && track.originalTitle !== track.artistName))
  const actions = (
    <TrackRowActions
      track={track}
      unavailable={unavailable}
      showRadio={showRadio}
      showLike={!visibleCols.has("rating")}
      onAddToQueue={onAddToQueue}
      onPlayRadio={onPlayRadio}
    />
  )
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
          className={`group/play flex h-7 w-7 items-center justify-center rounded-full hover:bg-hl-menu focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${isActive ? "text-accent" : "text-(--text-secondary)"}`}
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
                (presentation === "album" ? track.trackNumber : null) || idx + 1
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
          {presentation !== "album" &&
            (track.thumbUrl ? (
              <ArtworkImage
                className="h-10 w-10 shrink-0 rounded-sm object-cover"
                src={track.thumbUrl}
                alt=""
              />
            ) : (
              <div className="h-10 w-10 shrink-0 rounded-sm bg-app-surface" />
            ))}
          <div className="min-w-0 flex-1">
            <div className="track-row-title-line flex min-w-0 items-center gap-2">
              <MusicSourceBadge source={trackMusicSource(track, provider?.name)} />
              <span
                className={`truncate ${isActive ? "text-accent" : "text-(--text-primary)"}`}
              >
                {track.title}
              </span>
              {track.explicit && <span className="shrink-0 rounded bg-app-surface px-1 text-[10px] font-semibold text-(--text-secondary)" title="Explicit" aria-label="Explicit">E</span>}
              {showInlineDownload && (
                <DownloadBadge kind="track" id={track.id} />
              )}
              {presentation === "artist" && !!track.albumName && (
                <MusicEntityLink
                  entity={trackEntity(track, "album")}
                  className="min-w-0 truncate text-xs text-(--text-muted) hover:text-(--text-primary) hover:underline"
                >
                  · {track.albumName}
                </MusicEntityLink>
              )}
              {presentation === "artist" && !track.albumName && <span className="truncate text-xs text-(--text-muted)">· Release unavailable</span>}
              {presentation === "album" && !showArtist && <div className="ml-2 shrink-0">{actions}</div>}
            </div>
            {(presentation !== "album" || showArtist) && <div className="track-row-secondary-line flex min-w-0 items-center gap-2">
              {showArtist && (
                  <div className="track-row-artist min-w-0 shrink truncate">
                    <ArtistCredits item={track} className="text-(--text-muted) transition-colors hover:text-(--text-primary) hover:underline" />
                  </div>
                )}
              {actions}
            </div>}
          </div>
        </div>
      </td>

      {visibleCols.has("artist") && (
        <td className="max-w-[180px] truncate p-2">
          <ArtistCredits item={track} className="transition-colors hover:text-(--text-primary) hover:underline" />
        </td>
      )}

      {visibleCols.has("album") && (
        <td className="max-w-[200px] truncate p-2">
          <MusicEntityLink entity={trackEntity(track, "album")} className="transition-colors hover:text-(--text-primary) hover:underline">
            {track.albumName}
          </MusicEntityLink>
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
      {visibleCols.has("views") && <td className="p-2 text-right tabular-nums">{track.viewCount?.toLocaleString() ?? ""}</td>}
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
      {visibleCols.has("rated_at") && (
        <td className="whitespace-nowrap p-2">
          {formatDate(
            ratingDate
              ? new Date(ratingDate).toISOString()
              : (track.lastRatedAt ?? null)
          )}
        </td>
      )}
      {visibleCols.has("liked_at") && (
        <td className="whitespace-nowrap p-2">
          {formatDate(track.likedAt ?? null)}
        </td>
      )}
      {visibleCols.has("rating") && (
        <td className="p-2 text-right" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-3">
            {presentation ? (
              <HeroRating
                itemId={track.id}
                userRating={track.userRating}
                itemType="track"
                musicTrack={track}
              />
            ) : (
              <StarRating
                itemId={track.id}
                userRating={track.userRating}
                musicTrack={track}
                artist={track.artistName ?? ""}
                track={track.title}
              />
            )}
          </div>
        </td>
      )}
      <td className="track-row-duration whitespace-nowrap p-2 text-right tabular-nums">
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
  presentation,
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
  presentation?: "album" | "artist"
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
            <Skeleton className="h-10 w-10 shrink-0 rounded-sm" />
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
    presentation,
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
  const window = useVirtualWindow(count, 60, 1, count > 100)
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
            className="media-track-row"
            data-loading-index={idx}
            style={{ height: window.size }}
          >
            <td className="p-2 text-center text-(--text-muted)">
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
      const rowClass = `media-track-row group ${unavailable ? "opacity-40 cursor-default" : "cursor-pointer"} rounded ${isActive || isContextTarget ? "bg-hl-row" : "hover:bg-hl-row"}`
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
  onRemoveTrack,
  compact = false,
  presentation,
  showRadio = true,
  paged,
}: TrackTableProps) {
  const { handler, isTarget: isCtxTarget } = useContextMenu()
  const ctxMenu: typeof handler = (type, data, playlistId, extra = []) => handler(type, data, playlistId,
    onRemoveTrack && type === "track" ? [...extra, { label: "Remove from playlist", run: () => onRemoveTrack(data as MusicTrack) }] : extra)
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

  const orderedCols = TRACK_DATA_COLUMNS.filter((col) =>
    visibleCols.has(col.id)
  )
  const showInlineDownload =
    !columns.some((c) => c.id === "downloads") && !visibleCols.has("downloads")
  const fixedColumns = (
    <colgroup>
      <col style={{ width: compact ? 44 : 48 }} />
      <col />
      {orderedCols.map((col) => (
        <col key={col.id} style={{ width: compact ? "25%" : col.width }} />
      ))}
      {visibleCols.has("rating") && <col style={{ width: 148 }} />}
      <col style={{ width: compact ? 76 : 88 }} />
      {visibleCols.has("downloads") && <col style={{ width: 48 }} />}
    </colgroup>
  )
  const table = (
    <table
      className="track-table w-full table-fixed text-sm text-(--text-secondary)"
      aria-rowcount={(paged?.total ?? tracks.length) + 1}
      style={
        compact
          ? undefined
          : {
              minWidth:
                376 +
                orderedCols.reduce((sum, col) => sum + col.width, 0) +
                (visibleCols.has("rating") ? 148 : 0) +
                (visibleCols.has("downloads") ? 48 : 0),
            }
      }
    >
      {fixedColumns}
      <thead className="border-b border-(--border)">
        <tr>
          <th
            className="p-2 text-center"
            title={presentation ? undefined : defaultResetTitle}
            onClick={presentation ? undefined : () => onSort("default")}
          >
            #
          </th>
          {presentation ? (
            <th className="p-2 text-left">Title</th>
          ) : (
            <SortTh
              col="title"
              label="Title"
              active={sortCol}
              dir={sortDir}
              onSort={onSort}
              align="left"
            />
          )}
          {orderedCols.map((col) => (
            <SortTh
              key={col.id}
              col={col.id}
              label={col.label}
              active={sortCol}
              dir={sortDir}
              onSort={onSort}
              align={col.align ?? "left"}
            />
          ))}
          {visibleCols.has("rating") &&
            (presentation ? (
              <th className="p-2 text-right">Rating</th>
            ) : (
              <SortTh
                col="rating"
                label="Rating"
                active={sortCol}
                dir={sortDir}
                onSort={onSort}
                align="right"
              />
            ))}
          {presentation ? (
            <th className="p-2 text-right">Duration</th>
          ) : (
            <SortTh
              col="duration"
              label="Duration"
              active={sortCol}
              dir={sortDir}
              onSort={onSort}
              align="right"
            />
          )}
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
        presentation={presentation}
        showInlineDownload={showInlineDownload}
        playlistId={playlistId}
        reorderEnabled={reorderEnabled}
        trackDrag={trackDrag}
        compact={compact}
        showRadio={showRadio}
        paged={paged}
      />
    </table>
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
    <div className={compact || presentation ? "min-w-0" : "min-w-0 px-8 pt-2"}>
      {/* Toolbar row: search + column picker */}
      {!compact && !presentation && (
        <div className="flex items-center justify-between pb-1">
          <div className="relative">
            <svg
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-(--text-muted)"
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
            {table}
          </DndContext>
        ) : (
          table
        )}
      </div>

      {/* Sentinel + virtual spacer for infinite scroll */}
      {sentinel && <div ref={sentinel} />}
      {sentinel && spacerHeight > 0 && (
        <div style={{ height: `${spacerHeight}px` }} className="relative">
          {isFetchingMore && (
            <div className="flex items-center justify-center gap-2 pt-4 text-sm text-(--text-muted)">
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
          <div className="py-12 text-center text-sm text-(--text-muted)">
            {emptyMessage}
          </div>
        )}
      {paged?.error && (
        <div role="alert" className="py-4 text-sm text-(--text-secondary)">
          {paged.error}{" "}
          <button className="media-secondary ml-3" onClick={paged.retry}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}

const DETAIL_COLUMNS = new Set<ColId>(["rating"])
const NOOP = () => {}
/** The same rows, playback, context menu, dragging and virtualization as collections. */
export function DetailTrackList({
  presentation,
  tracks,
  onPlay,
  onAddToQueue,
  onPlayRadio,
  currentTrackId,
  showRadio,
  paged,
}: Pick<
  TrackTableProps,
  | "presentation"
  | "tracks"
  | "onPlay"
  | "onAddToQueue"
  | "onPlayRadio"
  | "currentTrackId"
  | "showRadio"
  | "paged"
>) {
  return (
    <TrackTable
      presentation={presentation}
      tracks={tracks}
      onPlay={onPlay}
      onAddToQueue={onAddToQueue}
      onPlayRadio={onPlayRadio}
      currentTrackId={currentTrackId}
      showRadio={showRadio}
      paged={paged}
      visibleCols={DETAIL_COLUMNS}
      toggleCol={NOOP}
      sortCol="default"
      sortDir="asc"
      onSort={NOOP}
      columns={[{ id: "rating", label: "Rating" }]}
      searchPlaceholder=""
      filterQuery=""
      onFilterChange={NOOP}
    />
  )
}
