import { useEffect, useMemo, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores/playerStore"
import { useUIStore } from "../stores/uiStore"
import { useLyricsOffsetStore } from "../stores/lyricsOffsetStore"
import { useResizable } from "../hooks/useResizable"
import { useCapability } from "../hooks/useCapability"

/** Format offset for display: 0ms, +200ms, -1.5s, etc. */
function formatOffset(ms: number): string {
  if (ms === 0) return "0ms"
  const sign = ms > 0 ? "+" : ""
  if (Math.abs(ms) >= 1000 && ms % 1000 === 0) return `${sign}${ms / 1000}s`
  if (Math.abs(ms) >= 1000) return `${sign}${(ms / 1000).toFixed(1)}s`
  return `${sign}${ms}ms`
}

/** Lyrics timing offset bar — centered drag slider rendered as a footer beneath lyrics. */
function LyricsOffsetBar() {
  const { offsetMs, setOffset, resetOffset } = useLyricsOffsetStore()
  return (
    <div className="flex items-center gap-3 border-t border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3 shrink-0">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-[color:var(--text-muted)]">
        Timing
      </span>
      <input
        type="range"
        min={-5000}
        max={5000}
        step={100}
        value={offsetMs}
        onChange={e => setOffset(parseInt(e.target.value, 10))}
        className="flex-1 range-styled accent-[var(--accent)] cursor-pointer"
      />
      <button
        onClick={resetOffset}
        onDoubleClick={resetOffset}
        title="Reset offset (double-click)"
        className={`shrink-0 text-xs tabular-nums transition-colors ${
          offsetMs !== 0
            ? "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] cursor-pointer"
            : "text-[color:var(--text-muted)]"
        }`}
      >
        {formatOffset(offsetMs)}
      </button>
    </div>
  )
}

/** Shared lyrics body used both in the standalone panel and the queue's Lyrics tab. */
export function LyricsContent() {
  const { lyricsLines, positionMs } = usePlayerStore(
    useShallow(s => ({ lyricsLines: s.lyricsLines, positionMs: s.positionMs }))
  )
  const offsetMs = useLyricsOffsetStore(s => s.offsetMs)
  const activeRef = useRef<HTMLButtonElement>(null)
  const lastIndexRef = useRef(0)

  // Reset scan position when the lyrics data changes (new track)
  useEffect(() => { lastIndexRef.current = 0 }, [lyricsLines])

  const activeIndex = useMemo(() => {
    if (!lyricsLines || lyricsLines.length === 0) return -1
    const adjustedPos = positionMs + offsetMs

    // Forward scan from last known position — O(1) amortized during normal playback
    let i = Math.max(0, lastIndexRef.current)
    while (i < lyricsLines.length) {
      const line = lyricsLines[i]
      if (adjustedPos >= line.startMs && (adjustedPos < line.endMs || i === lyricsLines.length - 1)) {
        lastIndexRef.current = i
        return i
      }
      if (adjustedPos < line.startMs) break
      i++
    }

    // Binary search fallback for backward seeks
    let lo = 0, hi = lyricsLines.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (adjustedPos >= lyricsLines[mid].startMs) lo = mid + 1
      else hi = mid - 1
    }
    if (hi >= 0) {
      lastIndexRef.current = hi
      return hi
    }
    return -1
  }, [lyricsLines, positionMs, offsetMs])

  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "center" })
    }
  }, [activeIndex])

  return (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-4 lyrics-scroll scrollbar scrollbar-w-1 scrollbar-track-transparent scrollbar-thumb-[var(--bg-surface)] hover:scrollbar-thumb-[var(--bg-surface-hover)]">
        {!lyricsLines ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[color:var(--text-muted)] text-sm text-center">Loading lyrics…</p>
          </div>
        ) : lyricsLines.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[color:var(--text-muted)] text-sm text-center">No lyrics available</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {lyricsLines.map((line, i) => {
              const isActive = i === activeIndex
              if (!line.text) return <div key={i} className="h-4" />
              return (
                <button
                  key={i}
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  className={`-mx-2 rounded-lg px-2 text-left text-2xl font-bold transition-all duration-300 cursor-pointer select-text ${
                    isActive
                      ? "text-accent"
                      : "text-[color:var(--text-muted)]/40 hover:text-[color:var(--text-muted)]/60 hover:bg-[var(--accent-tint-hover)]"
                  }`}
                  style={isActive ? { filter: "drop-shadow(0 0 8px rgb(var(--accent-rgb) / 0.15))" } : undefined}
                  onClick={() => usePlayerStore.getState().seekTo(line.startMs)}
                >
                  {line.text}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <LyricsOffsetBar />
    </>
  )
}

/** Pin icon — reused in header and QueuePanel tab header */
const PinIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
    <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z"/>
  </svg>
)

const CloseIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z" />
  </svg>
)

export default function LyricsPanel() {
  const hasLyrics = useCapability("lyrics")
  const {
    isLyricsOpen, isLyricsPinned, isQueuePinned,
    setLyricsOpen, setLyricsPinned,
  } = useUIStore(useShallow(s => ({
    isLyricsOpen: s.isLyricsOpen,
    isLyricsPinned: s.isLyricsPinned,
    isQueuePinned: s.isQueuePinned,
    setLyricsOpen: s.setLyricsOpen,
    setLyricsPinned: s.setLyricsPinned,
  })))
  const currentTrack = usePlayerStore(s => s.currentTrack)
  const { width: lyricsWidth, onMouseDown: onResizeMouseDown, isDragging: isResizing } = useResizable({
    key: "plex-lyrics-width",
    defaultWidth: 320,
    minWidth: 240,
    maxWidth: 600,
    direction: "left",
  })

  // Escape key to close overlay
  useEffect(() => {
    if (!isLyricsOpen || isLyricsPinned) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setLyricsOpen(false) }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [isLyricsOpen, isLyricsPinned])

  if (!hasLyrics) return null
  // When queue is pinned, lyrics live in the queue's Lyrics tab — nothing to render here
  if (isQueuePinned) return null

  const header = (
    <div className="shrink-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <span className="text-xs font-semibold text-[color:var(--text-muted)] uppercase tracking-wider">
          Lyrics
        </span>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={() => setLyricsPinned(!isLyricsPinned)}
            title={isLyricsPinned ? "Unpin lyrics" : "Pin lyrics to sidebar"}
            className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
              isLyricsPinned
                ? "text-accent hover:text-accent/70"
                : "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
            }`}
            aria-label={isLyricsPinned ? "Unpin lyrics" : "Pin lyrics"}
          >
            <PinIcon />
          </button>
          <button
            onClick={() => setLyricsOpen(false)}
            className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors"
            aria-label="Close lyrics"
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      {currentTrack && (
        <div
          className="mx-4 mt-3 rounded-lg border border-accent/10 p-3"
          style={{ background: "var(--accent-tint-subtle)" }}
        >
          <p className="truncate text-sm font-bold text-[color:var(--text-primary)]">{currentTrack.title}</p>
          {currentTrack.artistName && (
            <p className="truncate text-xs text-[color:var(--text-secondary)]">{currentTrack.artistName}</p>
          )}
        </div>
      )}
    </div>
  )

  // Pinned sidebar mode — renders as a flex column in the App layout
  if (isLyricsPinned) {
    return (
      <div
        className={`flex-shrink-0 overflow-hidden ${isResizing ? "" : "transition-[width] duration-300 ease-in-out"}`}
        style={{ width: isLyricsOpen ? lyricsWidth : 0 }}
      >
        <div
          className={`relative flex h-full flex-col bg-app-bg border-l border-[var(--border)] transition-transform duration-300 ease-in-out ${
            isLyricsOpen ? "translate-x-0" : "translate-x-full"
          }`}
          style={{ width: lyricsWidth }}
        >
          {/* Resize handle on left edge */}
          <div
            className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize z-10 hover:bg-white/10 transition-colors"
            onMouseDown={onResizeMouseDown}
          />
          {header}
          <LyricsContent />
        </div>
      </div>
    )
  }

  // Overlay mode — fixed slide-in panel with optional backdrop
  return (
    <>
      {isLyricsOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          onClick={() => setLyricsOpen(false)}
        />
      )}
      <div
        className={`fixed right-0 top-0 bottom-24 z-50 w-80 flex flex-col bg-app-bg border-l border-[var(--border)] shadow-2xl rounded-l-2xl overflow-hidden transition-transform duration-300 ease-in-out ${
          isLyricsOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {header}
        <LyricsContent />
      </div>
    </>
  )
}
