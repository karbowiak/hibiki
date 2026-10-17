import "../styles/shellArtwork.css"
import { useArtworkAppearanceStore } from "../stores/artworkAppearanceStore"
import { useContextMenu } from "../hooks/useContextMenu"
import { loadAlbumTracks } from "../lib/albumContents"
import { ArtworkImage } from "./shared/ArtworkImage"
import { useEffect, useRef, useState } from "react"
import { useResizable } from "../hooks/useResizable"
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
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores"
import { formatMs } from "../lib/formatters"
import { useUIStore } from "../stores/uiStore"
import {
  capturePlaybackSelectionVersion,
  isDjGenerated,
  isRadioGenerated,
} from "../stores/playerStore"
import { useDragStore } from "../stores/dragStore"
import type { DragPayload } from "../stores/dragStore"
import { useProviderStore } from "../stores/providerStore"
import type { MusicTrack } from "../types/music"
import { useAnnouncerStore } from "../stores/announcerStore"
import { LyricsContent } from "./LyricsPanel"
import { useVirtualWindow, virtualRef } from "../hooks/useVirtualWindow"
import { ensureQueueRange } from "../stores/playerStore"
import { isQueuePlaceholder, queueMemberKey } from "../lib/queueSession"

/* ------------------------------------------------------------------ */
/*  Track row shared between Played / Now Playing / Next Up           */
/* ------------------------------------------------------------------ */

interface TrackRowProps {
  thumb: string | null
  title: string
  artist: string
  durationMs: number
  isGuestDj: boolean
  isRadio: boolean
  onContextMenu?: (event: React.MouseEvent) => void
}

function TrackBadges({
  isGuestDj,
  isRadio,
}: {
  isGuestDj: boolean
  isRadio: boolean
}) {
  return (
    <>
      {isGuestDj && <span className="queue-track-badge">DJ</span>}
      {isRadio && !isGuestDj && (
        <span className="queue-track-badge">Radio</span>
      )}
    </>
  )
}

/* --- Played track (static, faded, no drag/remove) --- */

function PlayedRow({
  thumb,
  title,
  artist,
  durationMs,
  isGuestDj,
  isRadio,
  onJump,
  onContextMenu,
}: TrackRowProps & { onJump: () => void }) {
  return (
    <div
      className="queue-track-row queue-track-row--played flex cursor-pointer items-center gap-2 rounded-md hover:bg-hl-queue"
      onContextMenu={onContextMenu}
      onClick={onJump}
    >
      <span className="w-5 flex-shrink-0" />
      {thumb ? (
        <ArtworkImage
          src={thumb}
          alt=""
          className="h-10 w-10 flex-shrink-0 rounded-sm object-cover"
        />
      ) : (
        <div className="h-10 w-10 flex-shrink-0 rounded-sm bg-app-surface" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onJump()
            }}
            aria-label={`Play ${title}`}
            className="truncate rounded text-left text-sm text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {title}
          </button>
        </div>
        <div className="queue-track-meta">
          <span className="truncate">{artist}</span>
          <TrackBadges isGuestDj={isGuestDj} isRadio={isRadio} />
        </div>
      </div>
      <span className="flex-shrink-0 text-xs tabular-nums text-[var(--text-muted)]">
        {formatMs(durationMs)}
      </span>
      <span className="queue-remove-spacer" aria-hidden="true" />
    </div>
  )
}

/* --- Now Playing track (static, accent styling, no drag/remove) --- */

function NowPlayingRow({
  thumb,
  title,
  artist,
  durationMs,
  isGuestDj,
  isRadio,
  onContextMenu,
}: TrackRowProps) {
  return (
    <div
      className="queue-track-row queue-track-row--current flex items-center gap-2 rounded-md"
      onContextMenu={onContextMenu}
    >
      <span className="w-5 flex-shrink-0 text-center">
        <svg
          viewBox="0 0 16 16"
          width="10"
          height="10"
          style={{ fill: "var(--accent)" }}
          className="mx-auto"
        >
          <polygon points="3,2 13,8 3,14" />
        </svg>
      </span>
      {thumb ? (
        <ArtworkImage
          src={thumb}
          alt=""
          className="h-10 w-10 flex-shrink-0 rounded-sm object-cover"
        />
      ) : (
        <div className="h-10 w-10 flex-shrink-0 rounded-sm bg-app-surface" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-accent">
            {title}
          </span>
        </div>
        <div className="queue-track-meta">
          <span className="truncate">{artist}</span>
          <TrackBadges isGuestDj={isGuestDj} isRadio={isRadio} />
        </div>
      </div>
      <span className="flex-shrink-0 text-xs tabular-nums text-[var(--text-muted)]">
        {formatMs(durationMs)}
      </span>
      <span className="queue-remove-spacer" aria-hidden="true" />
    </div>
  )
}

/* --- Upcoming track (draggable, removable) --- */

interface SortableUpcomingProps extends TrackRowProps {
  id: string
  index: number
  onJump: () => void
  onRemove: () => void
}

function SortableUpcomingItem({
  id,
  index,
  thumb,
  title,
  artist,
  durationMs,
  isGuestDj,
  isRadio,
  onJump,
  onRemove,
  onContextMenu,
}: SortableUpcomingProps) {
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

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="queue-track-row group flex cursor-grab items-center gap-2 rounded-md hover:bg-hl-queue active:cursor-grabbing"
      onContextMenu={onContextMenu}
      onClick={() => {
        if (wasDragging.current) {
          wasDragging.current = false
          return
        }
        onJump()
      }}
      {...attributes}
      {...listeners}
      role="group"
      aria-label={title}
      tabIndex={-1}
    >
      <span className="w-5 flex-shrink-0 text-center text-xs tabular-nums text-[var(--text-muted)]">
        {index + 1}
      </span>

      {thumb ? (
        <ArtworkImage
          src={thumb}
          alt=""
          className="h-10 w-10 flex-shrink-0 rounded-sm object-cover"
        />
      ) : (
        <div className="h-10 w-10 flex-shrink-0 rounded-sm bg-app-surface" />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onJump()
            }}
            aria-label={`Play ${title}`}
            className="truncate rounded text-left text-sm text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {title}
          </button>
        </div>
        <div className="queue-track-meta">
          <span className="truncate">{artist}</span>
          <TrackBadges isGuestDj={isGuestDj} isRadio={isRadio} />
        </div>
      </div>

      <span className="flex-shrink-0 text-xs tabular-nums text-[var(--text-muted)]">
        {formatMs(durationMs)}
      </span>

      <button
        className="queue-remove-button flex-shrink-0 text-[var(--text-muted)] opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:text-[var(--text-primary)] focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        aria-label={`Remove ${title} from queue`}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z" />
        </svg>
      </button>
    </div>
  )
}

function QueueTrackList({
  queue,
  start,
  end,
  played,
  scrollRef,
  active,
  jump,
  remove,
  contextMenu,
}: {
  queue: MusicTrack[]
  start: number
  end: number
  played?: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
  active: boolean
  jump: (index: number) => void
  remove: (index: number) => void
  contextMenu: ReturnType<typeof useContextMenu>["handler"]
}) {
  const view = useVirtualWindow(
    Math.max(0, end - start),
    56,
    1,
    active && end - start > 80,
    scrollRef
  )
  const [error, setError] = useState("")
  const load = () => ensureQueueRange(start + view.start, start + view.end)
  useEffect(() => {
    if (!active) return
    let current = true
    void load().then(
      () => {
        if (current) setError("")
      },
      () => {
        if (current) setError("Could not load these queued songs.")
      }
    )
    return () => {
      current = false
    }
  }, [active, queue, start, view.start, view.end])
  if (!active) return null
  const indices = Array.from(
    { length: Math.max(0, view.end - view.start) },
    (_, i) => start + view.start + i
  )
  const rows = (
    <div
      ref={virtualRef<HTMLDivElement>(view.host)}
      style={{ overflowAnchor: "none" }}
    >
      {view.before > 0 && (
        <div aria-hidden="true" style={{ height: view.before }} />
      )}
      {indices.map((index, visible) => {
        const track = queue[index]
        if (!track) return null
        const props = {
          thumb: track.thumbUrl ?? null,
          title: track.title || "Loading song…",
          artist: track.artistName || "",
          durationMs: track.duration || 0,
          isGuestDj: isDjGenerated(track.id),
          isRadio: isRadioGenerated(track.id),
          onContextMenu: isQueuePlaceholder(track)
            ? undefined
            : contextMenu("track", track),
          onJump: () => jump(index),
        }
        return (
          <div
            key={queueMemberKey(track, index)}
            ref={
              visible === 0
                ? virtualRef<HTMLDivElement>(view.measure)
                : undefined
            }
            data-queue-index={index}
            style={{ height: "3.5rem" }}
          >
            {played ? (
              <PlayedRow {...props} />
            ) : (
              <SortableUpcomingItem
                {...props}
                id={String(index)}
                index={index - start}
                onRemove={() => remove(index)}
              />
            )}
          </div>
        )
      })}
      {view.after > 0 && (
        <div aria-hidden="true" style={{ height: view.after }} />
      )}
      {error && (
        <p role="alert" className="px-3 py-2 text-sm">
          {error}{" "}
          <button
            className="underline"
            onClick={() =>
              void load().then(
                () => setError(""),
                () => {}
              )
            }
          >
            Try again
          </button>
        </p>
      )}
    </div>
  )
  return played ? (
    rows
  ) : (
    <SortableContext
      items={indices.map(String)}
      strategy={verticalListSortingStrategy}
    >
      {rows}
    </SortableContext>
  )
}

/* ------------------------------------------------------------------ */
/*  Section header                                                     */
/* ------------------------------------------------------------------ */

function SectionHeader({
  label,
  right,
}: {
  label: string
  right?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-3">
      <span className="text-xs font-semibold text-[var(--text-secondary)]">
        {label}
      </span>
      {right}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Inline indicator row                                               */
/* ------------------------------------------------------------------ */

function IndicatorRow({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-muted)]">
      {icon}
      <span>{text}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  SVG icons for indicators                                           */
/* ------------------------------------------------------------------ */

function RepeatOneIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
      className="flex-shrink-0 text-accent"
    >
      <path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h.75v1.5h-.75A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5zM12.25 2.5A2.25 2.25 0 0 1 14.5 4.75v5A2.25 2.25 0 0 1 12.25 12h-.75v1.5h.75A3.75 3.75 0 0 0 16 9.75v-5A3.75 3.75 0 0 0 12.25 1H11v1.5h1.25z" />
      <path d="M4.5 1 2 3.5 4.5 6V1zM11.5 16l2.5-2.5L11.5 11v5z" />
      <text
        x="8"
        y="9.5"
        textAnchor="middle"
        fontSize="6"
        fontWeight="bold"
        fill="currentColor"
      >
        1
      </text>
    </svg>
  )
}

function RepeatIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
      className="flex-shrink-0 text-accent"
    >
      <path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h.75v1.5h-.75A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5zM12.25 2.5A2.25 2.25 0 0 1 14.5 4.75v5A2.25 2.25 0 0 1 12.25 12h-.75v1.5h.75A3.75 3.75 0 0 0 16 9.75v-5A3.75 3.75 0 0 0 12.25 1H11v1.5h1.25z" />
      <path d="M4.5 1 2 3.5 4.5 6V1zM11.5 16l2.5-2.5L11.5 11v5z" />
    </svg>
  )
}

function ShuffleIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
      className="flex-shrink-0 text-accent"
    >
      <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356A2.25 2.25 0 0 1 11.16 4.5h1.95l-1.018 1.018a.75.75 0 0 0 1.06 1.06l2.06-2.06a.78.78 0 0 0 0-1.06L13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
      <path d="m7.5 10.723.98-1.167 1.796 2.14a2.25 2.25 0 0 0 1.724.804h1.95l-1.018-1.018a.75.75 0 1 1 1.06-1.06l2.06 2.06a.78.78 0 0 1 0 1.06l-2.06 2.06a.75.75 0 1 1-1.06-1.06L13.109 13.5h-1.95a3.75 3.75 0 0 1-2.873-1.34L7.5 10.723z" />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/*  QueuePanel                                                         */
/* ------------------------------------------------------------------ */

export function QueuePanel() {
  const { handler: contextMenu } = useContextMenu()
  const backgroundArtworkEnabled = useArtworkAppearanceStore(
    (state) => state.backgroundArtworkEnabled
  )
  const {
    queue,
    queueIndex,
    reorderQueue,
    removeFromQueue,
    jumpToQueueItem,
    repeat,
    shuffle,
    clearUpcoming,
  } = usePlayerStore(
    useShallow((s) => ({
      queue: s.queue,
      queueIndex: s.queueIndex,
      reorderQueue: s.reorderQueue,
      removeFromQueue: s.removeFromQueue,
      jumpToQueueItem: s.jumpToQueueItem,
      repeat: s.repeat,
      shuffle: s.shuffle,
      clearUpcoming: s.clearUpcoming,
    }))
  )
  const {
    isQueueOpen,
    setQueueOpen,
    isQueuePinned,
    setQueuePinned,
    queueActiveTab,
    setQueueActiveTab,
  } = useUIStore(
    useShallow((s) => ({
      isQueueOpen: s.isQueueOpen,
      setQueueOpen: s.setQueueOpen,
      isQueuePinned: s.isQueuePinned,
      setQueuePinned: s.setQueuePinned,
      queueActiveTab: s.queueActiveTab,
      setQueueActiveTab: s.setQueueActiveTab,
    }))
  )
  const queueResize = useResizable({
    key: "plex-queue-width",
    defaultWidth: 320,
    minWidth: 240,
    maxWidth: 600,
    direction: "left",
  })
  const lyricsResize = useResizable({
    key: "plex-docked-lyrics-width",
    defaultWidth:
      typeof window !== "undefined" && window.innerWidth < 1100 ? 320 : 440,
    minWidth: 240,
    maxWidth: 600,
    direction: "left",
  })
  const {
    width: queueWidth,
    onMouseDown: onResizeMouseDown,
    isDragging: isResizing,
  } = isQueuePinned && queueActiveTab === "lyrics" ? lyricsResize : queueResize

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  const addToQueue = usePlayerStore((s) => s.addToQueue)
  const provider = useProviderStore((s) => s.provider)
  const isHoveredDrop = useDragStore((s) => s.isDragging && s.hoveredQueue)
  const [dropFlash, setDropFlash] = useState(false)

  // Resolve concurrently, then apply additions in drop order within one queue.
  useEffect(() => {
    let active = true
    let ordered = Promise.resolve()
    let selection = capturePlaybackSelectionVersion()
    let scope = provider?.cacheScope
    let flashTimer: ReturnType<typeof setTimeout> | null = null
    let errorTimer: ReturnType<typeof setTimeout> | null = null
    const message = "Could not add tracks to the queue. Try again."
    setDropFlash(false)
    function reportFailure() {
      usePlayerStore.setState({ playerError: message })
      useAnnouncerStore.getState().announce(message, "assertive")
      if (errorTimer !== null) clearTimeout(errorTimer)
      errorTimer = setTimeout(() => {
        if (active && usePlayerStore.getState().playerError === message)
          usePlayerStore.setState({ playerError: null })
      }, 6000)
    }
    function onQueueDrop(e: Event) {
      const detail = (e as CustomEvent).detail as
        { payload?: DragPayload; targetQueue?: boolean } | undefined
      if (
        !detail?.targetQueue ||
        !detail.payload ||
        useProviderStore.getState().provider !== provider
      )
        return
      const payload = detail.payload
      const version = capturePlaybackSelectionVersion()
      const capturedScope = provider?.cacheScope
      if (selection !== version || scope !== capturedScope) {
        // Retired I/O must not hold up drops intended for a replacement queue.
        ordered = Promise.resolve()
        selection = version
        scope = capturedScope
      }
      const current = () =>
        active &&
        useProviderStore.getState().provider === provider &&
        provider?.cacheScope === capturedScope &&
        capturePlaybackSelectionVersion() === version
      const result = Promise.resolve()
        .then(async () => {
          if (!current()) return []
          if (payload.type === "track") return [...(payload.tracks ?? [])]
          if (payload.type === "album" && provider)
            return loadAlbumTracks(provider, payload.ids[0])
          if (payload.type === "artist" && provider)
            return provider.getArtistPopularTracks(payload.ids[0])
          return []
        })
        .then(
          (tracks) => ({ tracks, failed: false }),
          () => ({ tracks: [] as MusicTrack[], failed: true })
        )
      ordered = ordered
        .then(() => result)
        .then(({ tracks, failed }) => {
          if (!current()) return
          if (failed) {
            reportFailure()
            return
          }
          if (!tracks.length) return
          addToQueue(tracks)
          setDropFlash(true)
          if (flashTimer !== null) clearTimeout(flashTimer)
          flashTimer = setTimeout(() => {
            if (active) setDropFlash(false)
          }, 1000)
        })
        .catch(() => {
          if (current()) reportFailure()
        })
    }
    window.addEventListener("plexify-media-drop", onQueueDrop)
    return () => {
      active = false
      window.removeEventListener("plexify-media-drop", onQueueDrop)
      if (flashTimer !== null) clearTimeout(flashTimer)
      if (errorTimer !== null) clearTimeout(errorTimer)
      if (usePlayerStore.getState().playerError === message)
        usePlayerStore.setState({ playerError: null })
    }
  }, [addToQueue, provider])

  const nowPlayingRef = useRef<HTMLDivElement>(null)

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const fromIndex = parseInt(String(active.id), 10)
    const toIndex = parseInt(String(over.id), 10)
    if (!isNaN(fromIndex) && !isNaN(toIndex)) {
      reorderQueue(fromIndex, toIndex)
    }
  }

  // Split queue into three sections
  const playedCount = queueIndex
  const currentTrack = queue[queueIndex] ?? null
  const upcomingCount = Math.max(0, queue.length - queueIndex - 1)

  const header = (
    <div
      className={`${isQueuePinned ? "app-docked-header " : ""}flex flex-shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-3`}
    >
      {isQueuePinned ? (
        <div
          role="group"
          aria-label="Player panel"
          className="flex min-w-0 flex-1 items-center gap-1.5"
        >
          <button
            onClick={() => setQueueActiveTab("queue")}
            aria-pressed={queueActiveTab === "queue"}
            className="panel-toolbar-button shell-control-secondary px-3 text-sm font-medium"
          >
            Queue
          </button>
          <button
            onClick={() => setQueueActiveTab("lyrics")}
            aria-pressed={queueActiveTab === "lyrics"}
            className="panel-toolbar-button shell-control-secondary px-3 text-sm font-medium"
          >
            Lyrics
          </button>
        </div>
      ) : (
        <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">
          Queue
        </h2>
      )}
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => {
            setQueuePinned(!isQueuePinned)
            setQueueOpen(true)
          }}
          title={isQueuePinned ? "Unpin queue" : "Pin queue to sidebar"}
          className={`panel-toolbar-button panel-toolbar-icon flex items-center justify-center rounded-full transition-colors ${
            isQueuePinned
              ? "text-accent hover:text-accent/70"
              : "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
          }`}
          aria-label={isQueuePinned ? "Unpin queue" : "Pin queue"}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z" />
          </svg>
        </button>
        <button
          onClick={() => setQueueOpen(false)}
          className="panel-toolbar-button panel-toolbar-icon flex items-center justify-center rounded-full text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-primary)]"
          aria-label="Close queue"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
            <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z" />
          </svg>
        </button>
      </div>
    </div>
  )

  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll so Now Playing sits at the top of the visible area.
  // Uses rAF to wait for layout after tab switches or panel open.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (nowPlayingRef.current && scrollRef.current) {
        const container = scrollRef.current
        const el = nowPlayingRef.current
        container.scrollTop = el.offsetTop - container.offsetTop
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [queueIndex, isQueueOpen, queueActiveTab])

  const list =
    queue.length === 0 ? (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center text-sm">
        <p className="font-medium text-[var(--text-primary)]">
          Your queue is empty
        </p>
        <p className="text-[var(--text-secondary)]">
          Play a song to add it here.
        </p>
      </div>
    ) : (
      <div
        ref={scrollRef}
        data-queue-scroll
        data-virtual-scroll
        className="flex-1 overflow-y-auto py-2"
      >
        {/* --- Played section --- */}
        {playedCount > 0 && (
          <>
            <SectionHeader
              label={`Played \u00b7 ${playedCount} item${playedCount !== 1 ? "s" : ""}`}
            />
            <QueueTrackList
              queue={queue}
              start={0}
              end={queueIndex}
              played
              scrollRef={scrollRef}
              active={isQueueOpen && queueActiveTab === "queue"}
              jump={jumpToQueueItem}
              remove={removeFromQueue}
              contextMenu={contextMenu}
            />
          </>
        )}

        {/* --- Now Playing section (always at top) --- */}
        {currentTrack && (
          <>
            <div ref={nowPlayingRef}>
              <SectionHeader
                label="Now Playing"
                right={
                  <span className="text-xs text-[var(--text-muted)]">
                    {queue.length.toLocaleString()} songs
                  </span>
                }
              />
              <NowPlayingRow
                thumb={currentTrack.thumbUrl}
                title={currentTrack.title}
                artist={currentTrack.artistName}
                durationMs={currentTrack.duration}
                isGuestDj={isDjGenerated(currentTrack.id)}
                isRadio={isRadioGenerated(currentTrack.id)}
                onContextMenu={contextMenu("track", currentTrack)}
              />
            </div>
            {repeat === 1 && (
              <IndicatorRow icon={<RepeatOneIcon />} text="Playing on repeat" />
            )}
          </>
        )}

        {/* --- Next Up section --- */}
        {upcomingCount > 0 && (
          <>
            <SectionHeader
              label={`Next Up \u00b7 ${upcomingCount} item${upcomingCount !== 1 ? "s" : ""}`}
              right={
                <button
                  onClick={clearUpcoming}
                  className="rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] transition-colors hover:bg-app-surface-hover hover:text-[var(--text-primary)]"
                >
                  Clear
                </button>
              }
            />
            {shuffle && <IndicatorRow icon={<ShuffleIcon />} text="Shuffled" />}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <QueueTrackList
                queue={queue}
                start={queueIndex + 1}
                end={queue.length}
                scrollRef={scrollRef}
                active={isQueueOpen && queueActiveTab === "queue"}
                jump={jumpToQueueItem}
                remove={removeFromQueue}
                contextMenu={contextMenu}
              />
            </DndContext>
            {repeat === 2 && (
              <IndicatorRow icon={<RepeatIcon />} text="Queue will repeat" />
            )}
          </>
        )}
      </div>
    )

  // Pinned mode
  if (isQueuePinned) {
    return (
      <div
        aria-hidden={!isQueueOpen}
        inert={!isQueueOpen}
        className={`flex-shrink-0 overflow-hidden ${isResizing ? "" : "transition-[width] duration-300 ease-in-out"}`}
        style={{ width: isQueueOpen ? queueWidth : 0 }}
      >
        <div
          data-queue-drop-target
          data-shell-transparency={
            backgroundArtworkEnabled ? "enabled" : undefined
          }
          className={`app-docked-panel shell-artwork-surface relative flex h-full flex-col border-l border-[var(--border)] bg-app-bg transition-shadow duration-200 ${isHoveredDrop ? "ring-2 ring-inset ring-accent/60" : ""} ${dropFlash ? "ring-2 ring-inset ring-green-500/60" : ""}`}
          style={{ width: queueWidth, minWidth: queueWidth }}
        >
          <div
            className="absolute bottom-0 left-0 top-0 z-10 w-1 cursor-ew-resize transition-colors hover:bg-white/10"
            onMouseDown={onResizeMouseDown}
          />
          {header}
          {queueActiveTab === "lyrics"
            ? isQueueOpen && <LyricsContent />
            : list}
        </div>
      </div>
    )
  }

  // Overlay mode
  return (
    <>
      {isQueueOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          onClick={() => setQueueOpen(false)}
        />
      )}
      <div
        aria-hidden={!isQueueOpen}
        inert={!isQueueOpen}
        data-queue-drop-target
        className={`app-overlay-surface fixed bottom-24 right-0 top-0 z-50 flex w-80 flex-col overflow-hidden rounded-l-2xl border-l border-[var(--border)] bg-app-bg shadow-2xl transition-[transform,box-shadow] duration-300 ease-in-out ${
          isQueueOpen ? "translate-x-0" : "translate-x-full"
        } ${isHoveredDrop ? "ring-2 ring-inset ring-accent/60" : ""} ${dropFlash ? "ring-2 ring-inset ring-green-500/60" : ""}`}
      >
        {header}
        {list}
      </div>
    </>
  )
}
