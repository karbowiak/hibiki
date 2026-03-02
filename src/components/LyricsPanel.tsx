import { useEffect, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores/playerStore"
import { useUIStore } from "../stores/uiStore"

/** Shared lyrics body used both in the standalone panel and the queue's Lyrics tab. */
export function LyricsContent() {
  const { lyricsLines, positionMs } = usePlayerStore(
    useShallow(s => ({ lyricsLines: s.lyricsLines, positionMs: s.positionMs }))
  )
  const activeRef = useRef<HTMLParagraphElement>(null)

  const activeIndex = lyricsLines
    ? lyricsLines.findIndex(
        (line, i) =>
          positionMs >= line.start_ms &&
          (positionMs < line.end_ms || i === lyricsLines.length - 1)
      )
    : -1

  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "center" })
    }
  }, [activeIndex])

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 scrollbar scrollbar-w-1 scrollbar-track-transparent scrollbar-thumb-[var(--bg-surface)] hover:scrollbar-thumb-[var(--bg-surface-hover)]">
      {!lyricsLines ? (
        <div className="flex items-center justify-center h-full">
          <p className="text-[color:var(--text-muted)] text-sm text-center">Loading lyrics…</p>
        </div>
      ) : lyricsLines.length === 0 ? (
        <div className="flex items-center justify-center h-full">
          <p className="text-[color:var(--text-muted)] text-sm text-center">No lyrics available</p>
        </div>
      ) : (
        lyricsLines.map((line, i) => {
          const isActive = i === activeIndex
          return (
            <p
              key={i}
              ref={isActive ? activeRef : undefined}
              className={`transition-all duration-300 leading-relaxed cursor-pointer select-text ${
                isActive
                  ? "text-[color:var(--text-primary)] text-base font-semibold"
                  : "text-[color:var(--text-muted)] text-sm hover:text-[color:var(--text-secondary)]"
              }`}
              onClick={() => usePlayerStore.getState().seekTo(line.start_ms)}
            >
              {line.text}
            </p>
          )
        })
      )}
    </div>
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

  // Escape key to close overlay
  useEffect(() => {
    if (!isLyricsOpen || isLyricsPinned) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setLyricsOpen(false) }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [isLyricsOpen, isLyricsPinned])

  // When queue is pinned, lyrics live in the queue's Lyrics tab — nothing to render here
  if (isQueuePinned) return null

  const header = (
    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
      <span className="text-xs font-semibold text-[color:var(--text-muted)] uppercase tracking-wider">
        Lyrics
      </span>
      {currentTrack && (
        <span className="mx-2 min-w-0 flex-1 truncate text-xs text-[color:var(--text-muted)]">
          {currentTrack.title}
        </span>
      )}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {/* Pin button */}
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
        {/* Close button */}
        <button
          onClick={() => setLyricsOpen(false)}
          className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors"
          aria-label="Close lyrics"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  )

  // Pinned sidebar mode — renders as a flex column in the App layout
  if (isLyricsPinned) {
    return (
      <div
        className={`flex-shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out ${
          isLyricsOpen ? "w-80" : "w-0"
        }`}
      >
        <div
          className={`flex h-full w-80 flex-col bg-app-bg border-l border-[var(--border)] transition-transform duration-300 ease-in-out ${
            isLyricsOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
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
