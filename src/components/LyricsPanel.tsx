import "../styles/shellArtwork.css"
import { useArtworkAppearanceStore } from "../stores/artworkAppearanceStore"
import { useEffect, useMemo, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores/playerStore"
import { useUIStore } from "../stores/uiStore"
import { useLyricsOffsetStore } from "../stores/lyricsOffsetStore"
import { useLyricsStore } from "../stores/lyricsStore"
import { useResizable } from "../hooks/useResizable"
import { useCapability } from "../hooks/useCapability"
import { useAlbumImage } from "../hooks/useMediaImage"
import { ArtworkImage } from "./shared/ArtworkImage"
import { PlaybackPalette } from "./PlaybackPalette"
import "../styles/lyrics.css"

/** Format offset for display: 0ms, +200ms, -1.5s, etc. */
function formatOffset(ms: number): string {
  if (ms === 0) return "0ms"
  const sign = ms > 0 ? "+" : ""
  if (Math.abs(ms) >= 1000 && ms % 1000 === 0) return `${sign}${ms / 1000}s`
  if (Math.abs(ms) >= 1000) return `${sign}${(ms / 1000).toFixed(1)}s`
  return `${sign}${ms}ms`
}

/** Lyrics timing offset bar — centered drag slider rendered as a footer beneath lyrics. */
function LyricsOffsetBar({ hidden }: { hidden?: boolean }) {
  const { offsetMs, setOffset, resetOffset } = useLyricsOffsetStore()
  if (hidden) return null
  return (
    <div className="lyrics-timing flex items-center gap-3 border-t border-(--border) px-4 py-3 shrink-0">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-(--text-muted)">
        Timing
      </span>
      <input
        type="range"
        aria-label="Lyrics timing offset"
        min={-15000}
        max={15000}
        step={100}
        value={offsetMs}
        onChange={e => setOffset(parseInt(e.target.value, 10))}
        className="flex-1 range-styled accent-(--accent) cursor-pointer"
      />
      <button
        onClick={resetOffset}
        onDoubleClick={resetOffset}
        title="Reset lyrics timing offset"
        aria-label="Reset lyrics timing offset"
        className={`shrink-0 text-xs tabular-nums transition-colors ${
          offsetMs !== 0
            ? "text-(--text-secondary) hover:text-(--text-primary) cursor-pointer"
            : "text-(--text-muted)"
        }`}
      >
        {formatOffset(offsetMs)}
      </button>
    </div>
  )
}

/** Source selector — shown when multiple sources or Genius hits exist. */
function LyricsSourceSelector() {
  const { sources, activeSourceId, geniusHits, isSearching, isFetchingLyrics, selectSource, fetchGeniusLyrics } =
    useLyricsStore(useShallow(s => ({
      sources: s.sources,
      activeSourceId: s.activeSourceId,
      geniusHits: s.geniusHits,
      isSearching: s.isSearching,
      isFetchingLyrics: s.isFetchingLyrics,
      selectSource: s.selectSource,
      fetchGeniusLyrics: s.fetchGeniusLyrics,
    })))

  const [expanded, setExpanded] = useState(false)

  const hasMultiple = sources.length > 1 || geniusHits.length > 0
  if (!hasMultiple && !isSearching) return null

  // Genius hits that aren't already loaded as sources
  const loadedIds = new Set(sources.filter(s => s.id.startsWith("genius-")).map(s => s.id.replace("genius-", "")))
  const unloadedHits = geniusHits.filter(h => !loadedIds.has(String(h.id)))

  return (
    <div className="shrink-0 border-b border-(--border) px-4 py-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        {sources.map(source => (
          <button
            key={source.id}
            onClick={() => selectSource(source.id)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              activeSourceId === source.id
                ? "bg-accent text-white"
                : "bg-(--bg-surface) text-(--text-secondary) hover:bg-(--bg-surface-hover)"
            }`}
          >
            {source.label}
            {!source.isSynced && <span className="ml-1 opacity-50">(plain)</span>}
          </button>
        ))}
        {isSearching && (
          <span className="text-xs text-(--text-muted) animate-pulse">Searching Genius...</span>
        )}
        {isFetchingLyrics && (
          <span className="text-xs text-(--text-muted) animate-pulse">Loading lyrics...</span>
        )}
        {unloadedHits.length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="rounded-full px-2 py-1 text-xs text-(--text-muted) hover:text-(--text-primary) transition-colors"
          >
            {expanded ? "Less" : `+${unloadedHits.length} more`}
          </button>
        )}
      </div>

      {expanded && unloadedHits.length > 0 && (
        <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
          {unloadedHits.map(hit => (
            <button
              key={hit.id}
              onClick={() => {
                void fetchGeniusLyrics(hit)
                setExpanded(false)
              }}
              className="flex items-center gap-2 w-full rounded-lg px-2 py-1.5 text-left hover:bg-(--bg-surface-hover) transition-colors"
            >
              {hit.thumbnail_url && (
                <img src={hit.thumbnail_url} alt="" className="w-6 h-6 rounded object-cover shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-(--text-primary) truncate">{hit.title}</p>
                <p className="text-[10px] text-(--text-muted) truncate">{hit.artist}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Shared lyrics body used both in the standalone panel and the queue's Lyrics tab. */
export function LyricsContent() {
  const { lyricsLines, positionMs, currentTrack } = usePlayerStore(
    useShallow(s => ({ lyricsLines: s.lyricsLines, positionMs: s.positionMs, currentTrack: s.currentTrack }))
  )
  const offsetMs = useLyricsOffsetStore(s => s.offsetMs)
  const artworkEnabled = useArtworkAppearanceStore(s => s.backgroundArtworkEnabled)
  const albumArtwork = useAlbumImage(currentTrack?.artistName ?? null, currentTrack?.albumName ?? null,
    currentTrack?.albumThumbUrl ?? currentTrack?.thumbUrl ?? null, currentTrack?.albumId)
  const artwork = albumArtwork ?? currentTrack?.artistThumbUrl ?? null
  const activeSource = useLyricsStore(s => {
    const src = s.sources.find(src => src.id === s.activeSourceId)
    return src ?? null
  })
  const isSynced = activeSource?.isSynced ?? true
  const activeRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastIndexRef = useRef(0)

  // Reset scan position when the lyrics data changes (new track)
  useEffect(() => { lastIndexRef.current = 0 }, [lyricsLines])

  const activeIndex = useMemo(() => {
    if (!isSynced) return -1 // No active line for unsynced lyrics
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
  }, [lyricsLines, positionMs, offsetMs, isSynced])

  useEffect(() => {
    if (isSynced && activeRef.current) {
      const container = scrollRef.current
      if (!container) return
      const line = activeRef.current
      // Layout coordinates stay stable while emphasis scales the painted text.
      // Scroll only the lyric viewport; never shift the album page or toolbar.
      const center = (smooth = false) => container.scrollTo?.({
        top: line.offsetTop + line.offsetHeight / 2 - container.clientHeight / 2,
        behavior: smooth && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto",
      })
      center(true)
      const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => center()) : null
      observer?.observe(container)
      observer?.observe(line)
      return () => observer?.disconnect()
    }
  }, [activeIndex, isSynced, lyricsLines])

  return (
    <PlaybackPalette src={artwork} className="lyrics-palette">
    <div className="lyrics-content" data-lyrics-synced={isSynced}>
      {artworkEnabled && artwork && (
        <div className="lyrics-artwork" aria-hidden="true">
          <ArtworkImage src={artwork} alt="" loading="eager" />
        </div>
      )}
      {currentTrack && (
        <div className="lyrics-track">
          <ArtworkImage src={artwork} alt="" className="lyrics-track-cover" />
          <div className="min-w-0">
            <p className="lyrics-track-title" title={currentTrack.title}>{currentTrack.title}</p>
            <p className="lyrics-track-artist" title={currentTrack.artistName}>{currentTrack.artistName}</p>
          </div>
        </div>
      )}
      <LyricsSourceSelector />
      <div ref={scrollRef} className="lyrics-scroll scrollbar scrollbar-w-1 scrollbar-track-transparent scrollbar-thumb-(--scrollbar-thumb) hover:scrollbar-thumb-(--scrollbar-thumb-hover)">
        {!currentTrack ? (
          <div className="flex items-center justify-center h-full px-3"><p role="status" className="text-(--text-secondary) text-sm text-center">Play a track to see its lyrics</p></div>
        ) : !lyricsLines ? (
          <div className="flex items-center justify-center h-full">
            <p role="status" className="text-(--text-secondary) text-sm text-center">Loading lyrics…</p>
          </div>
        ) : lyricsLines.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p role="status" className="text-(--text-secondary) text-sm text-center">No lyrics available</p>
          </div>
        ) : (
          <div className="lyrics-lines">
            {lyricsLines.map((line, i) => {
              const isActive = i === activeIndex
              if (!line.text) return <div key={i} className="h-4" />
              return (
                <button
                  key={i}
                  disabled={!isSynced}
                  aria-current={isActive ? "true" : undefined}
                  aria-label={isSynced ? `Seek to ${line.text}` : undefined}
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  className={`lyrics-line ${isActive ? "lyrics-line--active" : ""}`}
                  onClick={() => {
                    if (isSynced) usePlayerStore.getState().seekTo(line.startMs)
                  }}
                >
                  {line.text}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <LyricsOffsetBar hidden={!isSynced} />
    </div>
    </PlaybackPalette>
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
  const backgroundArtworkEnabled = useArtworkAppearanceStore(state => state.backgroundArtworkEnabled)
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
  const { width: lyricsWidth, onMouseDown: onResizeMouseDown, isDragging: isResizing } = useResizable({
    key: "plex-lyrics-width",
    defaultWidth: typeof window !== "undefined" && window.innerWidth < 1100 ? 320 : 440,
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
      <div className={`${isLyricsPinned ? "app-docked-header " : ""}flex items-center justify-between px-4 py-3 border-b border-(--border)`}>
        <span className="text-xs font-semibold text-(--text-muted) uppercase tracking-wider">
          Lyrics
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setLyricsPinned(!isLyricsPinned)}
            title={isLyricsPinned ? "Unpin lyrics" : "Pin lyrics to sidebar"}
            className={`panel-toolbar-button panel-toolbar-icon flex items-center justify-center rounded-full transition-colors ${
              isLyricsPinned
                ? "text-accent hover:text-accent/70"
                : "text-(--text-muted) hover:text-(--text-primary)"
            }`}
            aria-label={isLyricsPinned ? "Unpin lyrics" : "Pin lyrics"}
          >
            <PinIcon />
          </button>
          <button
            onClick={() => setLyricsOpen(false)}
            className="panel-toolbar-button panel-toolbar-icon flex items-center justify-center rounded-full text-(--text-muted) hover:text-(--text-primary) transition-colors"
            aria-label="Close lyrics"
          >
            <CloseIcon />
          </button>
        </div>
      </div>
    </div>
  )

  // Pinned sidebar mode — renders as a flex column in the App layout
  if (isLyricsPinned) {
    return (
      <div
        aria-hidden={!isLyricsOpen}
        inert={!isLyricsOpen}
        className={`shrink-0 overflow-hidden ${isResizing ? "" : "transition-[width] duration-300 ease-in-out"}`}
        style={{ width: isLyricsOpen ? lyricsWidth : 0 }}
      >
        <div
          data-shell-transparency={backgroundArtworkEnabled ? "enabled" : undefined}
          className={`app-docked-panel shell-artwork-surface relative flex h-full flex-col bg-app-bg border-l border-(--border) transition-transform duration-300 ease-in-out ${
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
          {isLyricsOpen && <LyricsContent />}
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
        aria-hidden={!isLyricsOpen}
        inert={!isLyricsOpen}
        className={`app-overlay-surface fixed right-0 top-0 bottom-24 z-50 w-80 flex flex-col bg-app-bg border-l border-(--border) shadow-2xl rounded-l-2xl overflow-hidden transition-transform duration-300 ease-in-out ${
          isLyricsOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {header}
        {isLyricsOpen && <LyricsContent />}
      </div>
    </>
  )
}
