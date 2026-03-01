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
import { isDjGenerated } from "../stores/playerStore"

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
      className={`flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer hover:bg-white/5 group ${isCurrent ? "border-l-2 border-[#1db954]" : ""}`}
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
          <svg viewBox="0 0 16 16" width="10" height="10" fill="#1db954" className="mx-auto">
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
        <div className="h-10 w-10 rounded-sm flex-shrink-0 bg-[#282828]" />
      )}

      {/* Track info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`truncate text-sm ${isCurrent ? "text-[#1db954] font-medium" : "text-white"}`}>
            {title}
          </span>
          {isGuestDj && (
            <span className="flex-shrink-0 rounded px-1 py-0.5 text-[0.55rem] font-bold uppercase tracking-wide bg-purple-500/20 text-purple-300">
              DJ
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
  const { isQueueOpen, setQueueOpen } = useUIStore(useShallow(s => ({
    isQueueOpen: s.isQueueOpen,
    setQueueOpen: s.setQueueOpen,
  })))
  const { baseUrl, token } = useConnectionStore(useShallow(s => ({ baseUrl: s.baseUrl, token: s.token })))

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const fromIndex = queue.findIndex(t => String(t.rating_key) === active.id)
    const toIndex = queue.findIndex(t => String(t.rating_key) === over.id)
    if (fromIndex !== -1 && toIndex !== -1) {
      reorderQueue(fromIndex, toIndex)
    }
  }

  // Items shown: current + upcoming
  const displayItems = queue.slice(queueIndex)

  return (
    <>
      {/* Backdrop */}
      {isQueueOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          onClick={() => setQueueOpen(false)}
        />
      )}

      {/* Slide-in panel */}
      <div
        className={`fixed right-0 top-0 bottom-24 z-50 w-80 flex flex-col bg-[#121212] border-l border-white/10 shadow-2xl transition-transform duration-300 ease-in-out ${
          isQueueOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
          <h2 className="text-sm font-semibold text-white">Queue</h2>
          <button
            onClick={() => setQueueOpen(false)}
            className="text-gray-400 hover:text-white transition-colors"
            aria-label="Close queue"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z" />
            </svg>
          </button>
        </div>

        {/* Queue list */}
        {displayItems.length === 0 ? (
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
                items={displayItems.map(t => String(t.rating_key))}
                strategy={verticalListSortingStrategy}
              >
                {displayItems.map((track, relIdx) => {
                  const absoluteIndex = queueIndex + relIdx
                  const isCurrent = absoluteIndex === queueIndex
                  const thumbPath = track.thumb ?? track.parent_thumb
                  const thumb = thumbPath ? buildPlexImageUrl(baseUrl, token, thumbPath) : null
                  return (
                    <SortableItem
                      key={track.rating_key}
                      id={String(track.rating_key)}
                      index={relIdx}
                      absoluteIndex={absoluteIndex}
                      isCurrent={isCurrent}
                      isGuestDj={isDjGenerated(track.rating_key)}
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
        )}
      </div>
    </>
  )
}
