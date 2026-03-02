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
import { usePlayerStore, useConnectionStore, buildPlexImageUrl } from "../stores"
import { useUIStore } from "../stores/uiStore"
import { isDjGenerated, isRadioGenerated } from "../stores/playerStore"
import { LyricsContent } from "./LyricsPanel"

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`
}

interface SortableItemProps {
  id: string
  index: number
  absoluteIndex: number
  isCurrent: boolean
  isGuestDj: boolean
  isRadio: boolean
  thumb: string | null
  title: string
  artist: string
  durationMs: number
  onJump: () => void
  onRemove: () => void
}

function SortableItem({
  id,
  index,
  isCurrent,
  isGuestDj,
  isRadio,
  thumb,
  title,
  artist,
  durationMs,
  onJump,
  onRemove,
}: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer hover:bg-white/5 group ${isCurrent ? "border-l-2 border-accent" : ""}`}
      onClick={onJump}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="flex-shrink-0 text-gray-600 hover:text-gray-300 cursor-grab active:cursor-grabbing p-0.5"
        onClick={e => e.stopPropagation()}
        aria-label="Drag to reorder"
      >
        <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
          <path d="M7 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM7 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM7 14a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z" />
        </svg>
      </button>

      {/* Position */}
      <span className="w-5 flex-shrink-0 text-center text-xs text-gray-500 tabular-nums">
        {isCurrent ? (
          <svg viewBox="0 0 16 16" width="10" height="10" style={{ fill: "var(--accent)" }} className="mx-auto">
            <polygon points="3,2 13,8 3,14" />
          </svg>
        ) : (
          index + 1
        )}
      </span>

      {/* Thumbnail */}
      {thumb ? (
        <img src={thumb} alt="" className="h-10 w-10 rounded-sm flex-shrink-0 object-cover" />
      ) : (
        <div className="h-10 w-10 rounded-sm flex-shrink-0 bg-app-surface" />
      )}

      {/* Track info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`truncate text-sm ${isCurrent ? "text-accent font-medium" : "text-white"}`}>
            {title}
          </span>
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
        </div>
        <div className="truncate text-xs text-gray-500">{artist}</div>
      </div>

      {/* Duration */}
      <span className="flex-shrink-0 text-xs tabular-nums text-gray-500">
        {formatMs(durationMs)}
      </span>

      {/* Remove button */}
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

export function QueuePanel() {
  const { queue, queueIndex, reorderQueue, removeFromQueue, jumpToQueueItem } = usePlayerStore(useShallow(s => ({
    queue: s.queue,
    queueIndex: s.queueIndex,
    reorderQueue: s.reorderQueue,
    removeFromQueue: s.removeFromQueue,
    jumpToQueueItem: s.jumpToQueueItem,
  })))
  const { isQueueOpen, setQueueOpen, isQueuePinned, setQueuePinned, queueActiveTab, setQueueActiveTab } = useUIStore(useShallow(s => ({
    isQueueOpen: s.isQueueOpen,
    setQueueOpen: s.setQueueOpen,
    isQueuePinned: s.isQueuePinned,
    setQueuePinned: s.setQueuePinned,
    queueActiveTab: s.queueActiveTab,
    setQueueActiveTab: s.setQueueActiveTab,
  })))
  const { baseUrl, token } = useConnectionStore(useShallow(s => ({ baseUrl: s.baseUrl, token: s.token })))

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const fromIndex = parseInt(String(active.id), 10)
    const toIndex = parseInt(String(over.id), 10)
    if (!isNaN(fromIndex) && !isNaN(toIndex)) {
      reorderQueue(fromIndex, toIndex)
    }
  }

  // Items shown: current + upcoming
  const displayItems = queue.slice(queueIndex)

  const header = (
    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] flex-shrink-0">
      {/* Tab bar when pinned, plain title when overlay */}
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
        {/* Pin button — toggles sticky sidebar mode */}
        <button
          onClick={() => setQueuePinned(!isQueuePinned)}
          title={isQueuePinned ? "Unpin queue" : "Pin queue to sidebar"}
          className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
            isQueuePinned ? "text-accent hover:text-accent/70" : "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
          }`}
          aria-label={isQueuePinned ? "Unpin queue" : "Pin queue"}
        >
          {/* Thumbtack / pin icon */}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z"/>
          </svg>
        </button>

        {/* Close button — closes the queue (and unpins if pinned) */}
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

  const list = displayItems.length === 0 ? (
    <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
      Queue is empty
    </div>
  ) : (
    <div className="flex-1 overflow-y-auto py-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={displayItems.map((_, i) => String(queueIndex + i))}
          strategy={verticalListSortingStrategy}
        >
          {displayItems.map((track, relIdx) => {
            const absoluteIndex = queueIndex + relIdx
            const isCurrent = absoluteIndex === queueIndex
            const thumbPath = track.thumb ?? track.parent_thumb
            const thumb = thumbPath ? buildPlexImageUrl(baseUrl, token, thumbPath) : null
            return (
              <SortableItem
                key={absoluteIndex}
                id={String(absoluteIndex)}
                index={relIdx}
                absoluteIndex={absoluteIndex}
                isCurrent={isCurrent}
                isGuestDj={isDjGenerated(track.rating_key)}
                isRadio={isRadioGenerated(track.rating_key)}
                thumb={thumb}
                title={track.title}
                artist={track.grandparent_title}
                durationMs={track.duration}
                onJump={() => jumpToQueueItem(absoluteIndex)}
                onRemove={() => removeFromQueue(absoluteIndex)}
              />
            )
          })}
        </SortableContext>
      </DndContext>
    </div>
  )

  // Pinned mode — renders as a sidebar column inside the layout flex row.
  // isQueueOpen controls visibility; the player queue button collapses/expands it.
  // Animation: outer wrapper collapses width while inner panel slides out to the right.
  if (isQueuePinned) {
    return (
      <div
        className={`flex-shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out ${
          isQueueOpen ? "w-80" : "w-0"
        }`}
      >
        <div
          className={`flex h-full w-80 flex-col bg-app-bg border-l border-[var(--border)] transition-transform duration-300 ease-in-out ${
            isQueueOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
          {header}
          {queueActiveTab === "lyrics" ? <LyricsContent /> : list}
        </div>
      </div>
    )
  }

  // Overlay mode — fixed slide-in panel with backdrop
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
