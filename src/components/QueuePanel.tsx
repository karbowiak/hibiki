import { useEffect, useRef } from "react"
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
import { isDjGenerated, isRadioGenerated } from "../stores/playerStore"
import { LyricsContent } from "./LyricsPanel"


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
}

function TrackBadges({ isGuestDj, isRadio }: { isGuestDj: boolean; isRadio: boolean }) {
  return (
    <>
      {isGuestDj && (
        <span className="flex-shrink-0 rounded px-1 py-0.5 text-[0.55rem] font-bold uppercase tracking-wide bg-purple-500/20 text-purple-300">
          DJ
        </span>
      )}
      {isRadio && !isGuestDj && (
        <span className="flex-shrink-0 rounded px-1 py-0.5 text-[0.55rem] font-bold uppercase tracking-wide bg-orange-500/20 text-orange-300">
          Radio
        </span>
      )}
    </>
  )
}

/* --- Played track (static, faded, no drag/remove) --- */

function PlayedRow({ thumb, title, artist, durationMs, isGuestDj, isRadio, onJump }: TrackRowProps & { onJump: () => void }) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer hover:bg-hl-queue opacity-50"
      onClick={onJump}
    >
      <span className="w-5 flex-shrink-0" />
      {thumb ? (
        <img src={thumb} alt="" className="h-10 w-10 rounded-sm flex-shrink-0 object-cover" />
      ) : (
        <div className="h-10 w-10 rounded-sm flex-shrink-0 bg-app-surface" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-sm text-white">{title}</span>
          <TrackBadges isGuestDj={isGuestDj} isRadio={isRadio} />
        </div>
        <div className="truncate text-xs text-gray-500">{artist}</div>
      </div>
      <span className="flex-shrink-0 text-xs tabular-nums text-gray-500">{formatMs(durationMs)}</span>
    </div>
  )
}

/* --- Now Playing track (static, accent styling, no drag/remove) --- */

function NowPlayingRow({ thumb, title, artist, durationMs, isGuestDj, isRadio }: TrackRowProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-l-2 border-accent">
      <span className="w-5 flex-shrink-0 text-center">
        <svg viewBox="0 0 16 16" width="10" height="10" style={{ fill: "var(--accent)" }} className="mx-auto">
          <polygon points="3,2 13,8 3,14" />
        </svg>
      </span>
      {thumb ? (
        <img src={thumb} alt="" className="h-10 w-10 rounded-sm flex-shrink-0 object-cover" />
      ) : (
        <div className="h-10 w-10 rounded-sm flex-shrink-0 bg-app-surface" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-sm text-accent font-medium">{title}</span>
          <TrackBadges isGuestDj={isGuestDj} isRadio={isRadio} />
        </div>
        <div className="truncate text-xs text-gray-500">{artist}</div>
      </div>
      <span className="flex-shrink-0 text-xs tabular-nums text-gray-500">{formatMs(durationMs)}</span>
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

function SortableUpcomingItem({ id, index, thumb, title, artist, durationMs, isGuestDj, isRadio, onJump, onRemove }: SortableUpcomingProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    animateLayoutChanges: () => false,
  })
  const wasDragging = useRef(false)
  useEffect(() => { if (isDragging) wasDragging.current = true }, [isDragging])

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 px-3 py-2 rounded-md cursor-grab active:cursor-grabbing hover:bg-hl-queue group"
      onClick={() => { if (wasDragging.current) { wasDragging.current = false; return } onJump() }}
      {...attributes}
      {...listeners}
    >
      <span className="w-5 flex-shrink-0 text-center text-xs text-gray-500 tabular-nums">
        {index + 1}
      </span>

      {thumb ? (
        <img src={thumb} alt="" className="h-10 w-10 rounded-sm flex-shrink-0 object-cover" />
      ) : (
        <div className="h-10 w-10 rounded-sm flex-shrink-0 bg-app-surface" />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-sm text-white">{title}</span>
          <TrackBadges isGuestDj={isGuestDj} isRadio={isRadio} />
        </div>
        <div className="truncate text-xs text-gray-500">{artist}</div>
      </div>

      <span className="flex-shrink-0 text-xs tabular-nums text-gray-500">{formatMs(durationMs)}</span>

      <button
        className="flex-shrink-0 text-gray-600 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
        onClick={e => { e.stopPropagation(); onRemove() }}
        aria-label="Remove from queue"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z" />
        </svg>
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Section header                                                     */
/* ------------------------------------------------------------------ */

function SectionHeader({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pt-3 pb-1">
      <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-gray-500">{label}</span>
      {right}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Inline indicator row                                               */
/* ------------------------------------------------------------------ */

function IndicatorRow({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-500">
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
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" className="text-accent flex-shrink-0">
      <path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h.75v1.5h-.75A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5zM12.25 2.5A2.25 2.25 0 0 1 14.5 4.75v5A2.25 2.25 0 0 1 12.25 12h-.75v1.5h.75A3.75 3.75 0 0 0 16 9.75v-5A3.75 3.75 0 0 0 12.25 1H11v1.5h1.25z" />
      <path d="M4.5 1 2 3.5 4.5 6V1zM11.5 16l2.5-2.5L11.5 11v5z" />
      <text x="8" y="9.5" textAnchor="middle" fontSize="6" fontWeight="bold" fill="currentColor">1</text>
    </svg>
  )
}

function RepeatIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" className="text-accent flex-shrink-0">
      <path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h.75v1.5h-.75A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5zM12.25 2.5A2.25 2.25 0 0 1 14.5 4.75v5A2.25 2.25 0 0 1 12.25 12h-.75v1.5h.75A3.75 3.75 0 0 0 16 9.75v-5A3.75 3.75 0 0 0 12.25 1H11v1.5h1.25z" />
      <path d="M4.5 1 2 3.5 4.5 6V1zM11.5 16l2.5-2.5L11.5 11v5z" />
    </svg>
  )
}

function ShuffleIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" className="text-accent flex-shrink-0">
      <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356A2.25 2.25 0 0 1 11.16 4.5h1.95l-1.018 1.018a.75.75 0 0 0 1.06 1.06l2.06-2.06a.78.78 0 0 0 0-1.06L13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
      <path d="m7.5 10.723.98-1.167 1.796 2.14a2.25 2.25 0 0 0 1.724.804h1.95l-1.018-1.018a.75.75 0 1 1 1.06-1.06l2.06 2.06a.78.78 0 0 1 0 1.06l-2.06 2.06a.75.75 0 1 1-1.06-1.06L13.109 13.5h-1.95a3.75 3.75 0 0 1-2.873-1.34L7.5 10.723z" />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/*  QueuePanel                                                         */
/* ------------------------------------------------------------------ */

export function QueuePanel() {
  const { queue, queueIndex, reorderQueue, removeFromQueue, jumpToQueueItem, repeat, shuffle, clearUpcoming } = usePlayerStore(useShallow(s => ({
    queue: s.queue,
    queueIndex: s.queueIndex,
    reorderQueue: s.reorderQueue,
    removeFromQueue: s.removeFromQueue,
    jumpToQueueItem: s.jumpToQueueItem,
    repeat: s.repeat,
    shuffle: s.shuffle,
    clearUpcoming: s.clearUpcoming,
  })))
  const { isQueueOpen, setQueueOpen, isQueuePinned, setQueuePinned, queueActiveTab, setQueueActiveTab } = useUIStore(useShallow(s => ({
    isQueueOpen: s.isQueueOpen,
    setQueueOpen: s.setQueueOpen,
    isQueuePinned: s.isQueuePinned,
    setQueuePinned: s.setQueuePinned,
    queueActiveTab: s.queueActiveTab,
    setQueueActiveTab: s.setQueueActiveTab,
  })))
  const { width: queueWidth, onMouseDown: onResizeMouseDown, isDragging: isResizing } = useResizable({
    key: "plex-queue-width",
    defaultWidth: 320,
    minWidth: 240,
    maxWidth: 600,
    direction: "left",
  })

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  const nowPlayingRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to Now Playing when the panel opens
  useEffect(() => {
    if (isQueueOpen && nowPlayingRef.current) {
      nowPlayingRef.current.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }, [isQueueOpen])

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
  const playedTracks = queue.slice(0, queueIndex)
  const currentTrack = queue[queueIndex] ?? null
  const upcomingTracks = queue.slice(queueIndex + 1)

  const header = (
    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] flex-shrink-0">
      {isQueuePinned ? (
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <button
            onClick={() => setQueueActiveTab("queue")}
            className={`text-sm font-semibold pb-0.5 transition-colors border-b-2 ${
              queueActiveTab === "queue"
                ? "text-[color:var(--text-primary)] border-accent"
                : "text-[color:var(--text-muted)] border-transparent hover:text-[color:var(--text-secondary)]"
            }`}
          >
            Queue
          </button>
          <button
            onClick={() => setQueueActiveTab("lyrics")}
            className={`text-sm font-semibold pb-0.5 transition-colors border-b-2 ${
              queueActiveTab === "lyrics"
                ? "text-[color:var(--text-primary)] border-accent"
                : "text-[color:var(--text-muted)] border-transparent hover:text-[color:var(--text-secondary)]"
            }`}
          >
            Lyrics
          </button>
        </div>
      ) : (
        <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">Queue</h2>
      )}
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => setQueuePinned(!isQueuePinned)}
          title={isQueuePinned ? "Unpin queue" : "Pin queue to sidebar"}
          className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
            isQueuePinned ? "text-accent hover:text-accent/70" : "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
          }`}
          aria-label={isQueuePinned ? "Unpin queue" : "Pin queue"}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z"/>
          </svg>
        </button>
        <button
          onClick={() => {
            if (isQueuePinned) setQueuePinned(false)
            else setQueueOpen(false)
          }}
          className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors"
          aria-label="Close queue"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
            <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z" />
          </svg>
        </button>
      </div>
    </div>
  )

  const list = queue.length === 0 ? (
    <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
      Queue is empty
    </div>
  ) : (
    <div className="flex-1 overflow-y-auto py-2">
      {/* --- Played section --- */}
      {playedTracks.length > 0 && (
        <>
          <SectionHeader label={`Played \u00b7 ${playedTracks.length} item${playedTracks.length !== 1 ? "s" : ""}`} />
          {playedTracks.map((track, i) => (
            <PlayedRow
              key={i}
              thumb={track.thumbUrl}
              title={track.title}
              artist={track.artistName}
              durationMs={track.duration}
              isGuestDj={isDjGenerated(track.id)}
              isRadio={isRadioGenerated(track.id)}
              onJump={() => jumpToQueueItem(i)}
            />
          ))}
        </>
      )}

      {/* --- Now Playing section --- */}
      {currentTrack && (
        <>
          <div ref={nowPlayingRef}>
            <SectionHeader label="Now Playing" />
            <NowPlayingRow
              thumb={currentTrack.thumbUrl}
              title={currentTrack.title}
              artist={currentTrack.artistName}
              durationMs={currentTrack.duration}
              isGuestDj={isDjGenerated(currentTrack.id)}
              isRadio={isRadioGenerated(currentTrack.id)}
            />
          </div>
          {repeat === 1 && (
            <IndicatorRow icon={<RepeatOneIcon />} text="Playing on repeat" />
          )}
        </>
      )}

      {/* --- Next Up section --- */}
      {upcomingTracks.length > 0 && (
        <>
          <SectionHeader
            label={`Next Up \u00b7 ${upcomingTracks.length} item${upcomingTracks.length !== 1 ? "s" : ""}`}
            right={
              <button
                onClick={clearUpcoming}
                className="text-[0.65rem] font-semibold uppercase tracking-wider text-gray-500 hover:text-white transition-colors"
              >
                Clear
              </button>
            }
          />
          {shuffle && (
            <IndicatorRow icon={<ShuffleIcon />} text="Shuffled" />
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={upcomingTracks.map((_, i) => String(queueIndex + 1 + i))}
              strategy={verticalListSortingStrategy}
            >
              {upcomingTracks.map((track, i) => {
                const absoluteIndex = queueIndex + 1 + i
                return (
                  <SortableUpcomingItem
                    key={absoluteIndex}
                    id={String(absoluteIndex)}
                    index={i}
                    thumb={track.thumbUrl}
                    title={track.title}
                    artist={track.artistName}
                    durationMs={track.duration}
                    isGuestDj={isDjGenerated(track.id)}
                    isRadio={isRadioGenerated(track.id)}
                    onJump={() => jumpToQueueItem(absoluteIndex)}
                    onRemove={() => removeFromQueue(absoluteIndex)}
                  />
                )
              })}
            </SortableContext>
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
        className={`flex-shrink-0 overflow-hidden ${isResizing ? "" : "transition-[width] duration-300 ease-in-out"}`}
        style={{ width: isQueueOpen ? queueWidth : 0 }}
      >
        <div
          className="relative flex h-full flex-col bg-app-bg border-l border-[var(--border)]"
          style={{ width: queueWidth, minWidth: queueWidth }}
        >
          <div
            className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize z-10 hover:bg-white/10 transition-colors"
            onMouseDown={onResizeMouseDown}
          />
          {header}
          {queueActiveTab === "lyrics" ? <LyricsContent /> : list}
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
        className={`fixed right-0 top-0 bottom-24 z-50 w-80 flex flex-col bg-app-bg border-l border-[var(--border)] shadow-2xl rounded-l-2xl overflow-hidden transition-transform duration-300 ease-in-out ${
          isQueueOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {header}
        {list}
      </div>
    </>
  )
}
