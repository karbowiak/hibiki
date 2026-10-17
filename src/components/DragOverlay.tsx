import { useDragStore } from "../stores/dragStore"

/**
 * Floating ghost element that follows the cursor during a pointer-based drag.
 * Render once at the app root level.
 */
export function DragOverlay() {
  const isDragging = useDragStore(s => s.isDragging)
  const payload = useDragStore(s => s.payload)
  const x = useDragStore(s => s.cursorX)
  const y = useDragStore(s => s.cursorY)
  const hoveredPlaylist = useDragStore(s => s.hoveredPlaylistId)
  const hoveredQueue = useDragStore(s => s.hoveredQueue)

  if (!isDragging || !payload) return null

  const isOverTarget = !!hoveredPlaylist || hoveredQueue

  const icon = payload.type === "artist" ? (
    // person icon
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" className="shrink-0">
      <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm5 6a5 5 0 0 0-10 0h10z" />
    </svg>
  ) : payload.type === "album" ? (
    // disc icon
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" className="shrink-0">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" />
    </svg>
  ) : (
    // track/music icon
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" className="shrink-0">
      <path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3zm0 4.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-1zm1 3.5a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1a1 1 0 0 0-1-1H3z" />
    </svg>
  )

  return (
    <div
      className={`fixed z-9999 pointer-events-none flex items-center gap-2 rounded-md backdrop-blur-sm border px-3 py-1.5 text-sm shadow-xl transition-colors ${
        isOverTarget
          ? "bg-accent/90 border-accent/60 text-white"
          : "bg-app-surface/95 border-white/20 text-white"
      }`}
      style={{
        left: x + 12,
        top: y - 14,
      }}
    >
      {icon}
      <span className="truncate max-w-[200px]">{payload.label}</span>
      {hoveredQueue && (
        <span className="shrink-0 text-xs opacity-80">+ Queue</span>
      )}
    </div>
  )
}
