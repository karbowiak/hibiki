import { useEffect, useRef, useState } from "react"
import { Link } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore, useConnectionStore, buildPlexImageUrl } from "../stores"
import { DJ_MODES, type DjMode } from "../stores/playerStore"
import { useUIStore } from "../stores/uiStore"
import { useEqStore } from "../stores/eqStore"
import { useAudioSettingsStore } from "../stores/audioSettingsStore"
import { useVisualizerStore } from "../stores/visualizerStore"
import { reportTimeline, audioSetCacheMaxBytes, audioSetVisualizerEnabled } from "../lib/plex"
import EqPanel from "./EqPanel"
import SleepTimerPanel from "./SleepTimerPanel"
import TrackInfoPanel from "./TrackInfoPanel"
import VisualizerCanvas from "./VisualizerCanvas"
import VisualizerFullscreen from "./VisualizerFullscreen"
import { useSleepTimerStore } from "../stores/sleepTimerStore"

const CACHE_SIZE_KEY = "plexify-audio-cache-max-bytes"

function formatMs(ms: number): string {
  if (!ms || isNaN(ms)) return "0:00"
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`
}

export function Player() {
  const positionRef = useRef(0)
  const volumeAreaRef = useRef<HTMLDivElement>(null)
  const djButtonRef = useRef<HTMLButtonElement>(null)
  const [djMenuPos, setDjMenuPos] = useState<{ bottom: number; right: number } | null>(null)
  const [seekHoverPct, setSeekHoverPct] = useState<number | null>(null)
  const [trackInfoOpen, setTrackInfoOpen] = useState(false)

  const {
    currentTrack,
    isPlaying,
    positionMs,
    volume,
    shuffle,
    repeat,
    isRadioMode,
    djMode,
    playerError,
    contextName,
    contextHref,
    waveformLevels,
    lyricsLines,
    pause,
    resume,
    next,
    prev,
    seekTo,
    setVolume,
    toggleShuffle,
    cycleRepeat,
    setDjMode,
    stopRadio,
    initAudioEvents,
  } = usePlayerStore()

  const { compactMode, cycleCompactMode, openFullscreen, fullscreenOpen } = useVisualizerStore(
    useShallow(s => ({
      compactMode: s.compactMode,
      cycleCompactMode: s.cycleCompactMode,
      openFullscreen: s.openFullscreen,
      fullscreenOpen: s.fullscreenOpen,
    }))
  )

  const [djMenuOpen, setDjMenuOpen] = useState(false)
  const [sleepTimerOpen, setSleepTimerOpen] = useState(false)
  const [sleepRemaining, setSleepRemaining] = useState<string | null>(null)
  const { endsAt: sleepEndsAt, hydrate: hydrateSleepTimer } = useSleepTimerStore(useShallow(s => ({ endsAt: s.endsAt, hydrate: s.hydrate })))

  const { baseUrl, token } = useConnectionStore()
  const {
    isQueueOpen, setQueueOpen,
    isQueuePinned, queueActiveTab, setQueueActiveTab,
    isLyricsOpen, setLyricsOpen,
  } = useUIStore(useShallow(s => ({
    isQueueOpen: s.isQueueOpen,
    setQueueOpen: s.setQueueOpen,
    isQueuePinned: s.isQueuePinned,
    queueActiveTab: s.queueActiveTab,
    setQueueActiveTab: s.setQueueActiveTab,
    isLyricsOpen: s.isLyricsOpen,
    setLyricsOpen: s.setLyricsOpen,
  })))
  const { isEqOpen, setEqOpen, enabled: eqEnabled, syncToEngine } = useEqStore(useShallow(s => ({ isEqOpen: s.isEqOpen, setEqOpen: s.setEqOpen, enabled: s.enabled, syncToEngine: s.syncToEngine })))
  const syncAudioSettings = useAudioSettingsStore(s => s.syncToEngine)

  // Keep positionRef in sync for the timeline reporting interval
  positionRef.current = positionMs

  // Initialize Rust audio engine event listeners on mount.
  // Also apply any persisted cache size limit before playback starts.
  useEffect(() => {
    const saved = localStorage.getItem(CACHE_SIZE_KEY)
    if (saved !== null) {
      const bytes = parseInt(saved, 10)
      if (!isNaN(bytes)) void audioSetCacheMaxBytes(bytes).catch(() => {})
    }

    let cleanup: (() => void) | undefined
    hydrateSleepTimer()
    initAudioEvents().then((fn) => {
      cleanup = fn
      syncToEngine()
      syncAudioSettings()
    })
    return () => {
      cleanup?.()
    }
  }, [])

  // Forward PCM frames from the Rust audio engine into the visualizer ring buffer.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event")
      unlisten = await listen<number[]>("audio://vis-frame", (e) => {
        useVisualizerStore.getState().pushPcm(e.payload)
      })
    })()
    return () => { unlisten?.() }
  }, [])

  // Gate PCM bridge — only run when a live-data visualizer mode is active
  useEffect(() => {
    const needsPcm = compactMode !== "waveform" || fullscreenOpen
    void audioSetVisualizerEnabled(needsPcm).catch(() => {})
  }, [compactMode, fullscreenOpen])

  // Report timeline to Plex every 10 seconds during playback
  useEffect(() => {
    if (!currentTrack || !isPlaying) return
    const id = setInterval(() => {
      void reportTimeline(currentTrack.rating_key, "playing", positionRef.current, currentTrack.duration)
    }, 10000)
    return () => clearInterval(id)
  }, [currentTrack?.rating_key, isPlaying])

  // Media session action handlers — wire OS media keys / headphone controls / Control Center
  useEffect(() => {
    if (!navigator.mediaSession) return
    navigator.mediaSession.setActionHandler("play", () => resume())
    navigator.mediaSession.setActionHandler("pause", () => pause())
    navigator.mediaSession.setActionHandler("previoustrack", () => prev())
    navigator.mediaSession.setActionHandler("nexttrack", () => next())
    navigator.mediaSession.setActionHandler("stop", () => pause())
    return () => {
      for (const action of ["play", "pause", "previoustrack", "nexttrack", "stop"] as const) {
        navigator.mediaSession.setActionHandler(action, null)
      }
    }
  }, [])

  // Media session metadata + playback state — update whenever track or play state changes
  useEffect(() => {
    if (!navigator.mediaSession) return
    if (currentTrack) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title,
        artist: currentTrack.grandparent_title,
        album: currentTrack.parent_title,
      })
    }
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused"
  }, [currentTrack?.rating_key, isPlaying])

  // Global space bar → play/pause (ignored when focus is in a text field)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return
      e.preventDefault()
      if (!currentTrack) return
      if (isPlaying) pause()
      else resume()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [currentTrack, isPlaying])

  // Close sleep timer panel on outside click (SleepTimerPanel dispatches a custom event)
  useEffect(() => {
    const handler = () => setSleepTimerOpen(false)
    document.addEventListener("sleep-timer-outside-click", handler)
    return () => document.removeEventListener("sleep-timer-outside-click", handler)
  }, [])

  // Live countdown for sleep timer
  useEffect(() => {
    if (!sleepEndsAt) {
      setSleepRemaining(null)
      return
    }
    const tick = () => {
      const diff = sleepEndsAt - Date.now()
      if (diff <= 0) { setSleepRemaining(null); return }
      const totalSec = Math.ceil(diff / 1000)
      const m = Math.floor(totalSec / 60)
      const s = totalSec % 60
      setSleepRemaining(`${m}:${s.toString().padStart(2, '0')}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [sleepEndsAt])

  // Scroll wheel on volume area — must be non-passive to call preventDefault()
  useEffect(() => {
    const el = volumeAreaRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // deltaY < 0 = scroll up = louder; each notch ≈ 2.5 units
      const delta = e.deltaY < 0 ? 2.5 : -2.5
      // Read latest volume directly from store (avoids stale closure)
      setVolume(usePlayerStore.getState().volume + delta)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // Prefer track thumb; fall back to album thumb (smart playlists return parent_thumb)
  const thumbPath = currentTrack?.thumb ?? currentTrack?.parent_thumb
  const thumbUrl = thumbPath ? buildPlexImageUrl(baseUrl, token, thumbPath) : null

  const artistId = currentTrack?.grandparent_key?.split("/").pop()
  const albumId = currentTrack?.parent_key?.split("/").pop()

  const progressPct = currentTrack?.duration
    ? (positionMs / currentTrack.duration) * 100
    : 0

  const repeatActive = repeat > 0
  const shuffleActive = shuffle

  return (
    <div className="relative border-t border-[var(--border)]">
      {/* Error toast — shown briefly when playRadio or other player actions fail */}
      {playerError && (
        <div className="absolute bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-red-900/90 px-4 py-2 text-sm text-white shadow-xl backdrop-blur-sm max-w-md text-center">
          {playerError}
        </div>
      )}
      {/* Panels — float above the player bar; rendered here so they escape overflow-clip */}
      {isEqOpen && <EqPanel />}
      {sleepTimerOpen && <SleepTimerPanel />}
      {trackInfoOpen && currentTrack && <TrackInfoPanel onClose={() => setTrackInfoOpen(false)} />}
      {fullscreenOpen && <VisualizerFullscreen />}
      <div className="flex h-fit w-screen min-w-[620px] flex-col overflow-clip rounded-b-lg bg-app-card">
        <div className="h-24">
          <div className="flex h-full items-center justify-between px-4">

            {/* Left: current track info */}
            <div className="w-[30%] min-w-[11.25rem]">
              <div className="flex items-center">
                <div className="mr-3 flex items-center">
                  <div className="mr-3 h-14 w-14 flex-shrink-0">
                    {thumbUrl ? (
                      <img src={thumbUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="h-full w-full bg-app-surface" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <h6 className="line-clamp-1 text-sm font-medium text-white">
                      {albumId ? (
                        <Link href={`/album/${albumId}`} className="hover:underline">
                          {currentTrack?.title ?? ""}
                        </Link>
                      ) : (currentTrack?.title ?? "")}
                    </h6>
                    <p className="truncate text-[0.688rem] text-white/60 mt-0.5">
                      {artistId ? (
                        <Link href={`/artist/${artistId}`} className="hover:text-white hover:underline transition-colors">
                          {currentTrack?.grandparent_title ?? ""}
                        </Link>
                      ) : (currentTrack?.grandparent_title ?? "")}
                      {currentTrack?.parent_title && albumId && (
                        <>
                          <span className="mx-1 text-white/30">·</span>
                          <Link href={`/album/${albumId}`} className="hover:text-white hover:underline transition-colors">
                            {currentTrack.parent_title}
                          </Link>
                        </>
                      )}
                    </p>
                    {contextName && (
                      <p className="text-[0.625rem] text-white/35 truncate mt-0.5">
                        {contextHref ? (
                          <Link href={contextHref} className="hover:text-white/60 hover:underline transition-colors">
                            {contextName}
                          </Link>
                        ) : (
                          contextName
                        )}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Center: controls + progress */}
            <div className="flex w-[40%] max-w-[45.125rem] flex-col items-center px-4 pt-2">
              <div className="flex items-center gap-x-2">

                {/* Shuffle */}
                <button
                  onClick={toggleShuffle}
                  className={`flex h-8 w-8 items-center justify-center transition-colors ${shuffleActive ? "text-accent" : "text-white text-opacity-70 hover:text-opacity-100"}`}
                >
                  <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
                    <path d="m7.5 10.723.98-1.167.957 1.14a2.25 2.25 0 0 0 1.724.804h1.947l-1.017-1.018a.75.75 0 1 1 1.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 1 1-1.06-1.06L13.109 13H11.16a3.75 3.75 0 0 1-2.873-1.34l-.787-.938z" />
                  </svg>
                </button>

                {/* Prev */}
                <button
                  onClick={prev}
                  className="flex h-8 w-8 items-center justify-center text-white text-opacity-70 hover:text-opacity-100"
                >
                  <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.575a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7h1.6z" />
                  </svg>
                </button>

                {/* Play/Pause */}
                <button
                  onClick={isPlaying ? pause : resume}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-base)] hover:scale-[1.06]"
                >
                  {isPlaying ? (
                    <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z" />
                    </svg>
                  ) : (
                    <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z" />
                    </svg>
                  )}
                </button>

                {/* Next */}
                <button
                  onClick={next}
                  className="flex h-8 w-8 items-center justify-center text-white text-opacity-70 hover:text-opacity-100"
                >
                  <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.107A.7.7 0 0 0 1 1.712v12.575a.7.7 0 0 0 1.05.607L12 9.149V14.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-1.6z" />
                  </svg>
                </button>

                {/* Repeat */}
                <button
                  onClick={cycleRepeat}
                  className={`flex h-8 w-8 items-center justify-center transition-colors ${repeatActive ? "text-accent" : "text-white text-opacity-70 hover:text-opacity-100"}`}
                >
                  <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h8.5A3.75 3.75 0 0 1 16 4.75v5a3.75 3.75 0 0 1-3.75 3.75H9.81l1.018 1.018a.75.75 0 1 1-1.06 1.06L6.939 12.75l2.829-2.828a.75.75 0 1 1 1.06 1.06L9.811 12h2.439a2.25 2.25 0 0 0 2.25-2.25v-5a2.25 2.25 0 0 0-2.25-2.25h-8.5A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5z" />
                  </svg>
                </button>
              </div>

              {/* Progress / seek bar */}
              <div className="mt-1.5 flex w-full items-center gap-x-2">
                <div className="text-[0.688rem] text-white text-opacity-70">
                  {formatMs(seekHoverPct !== null
                    ? (currentTrack?.duration ?? 0) * seekHoverPct / 100
                    : positionMs)}
                </div>
                <div
                  className="relative flex-1 h-7 cursor-pointer select-none"
                  onMouseMove={e => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    setSeekHoverPct(Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)))
                  }}
                  onMouseLeave={() => setSeekHoverPct(null)}
                  onClick={e => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                    seekTo((currentTrack?.duration ?? 0) * pct)
                  }}
                >
                  <VisualizerCanvas
                    progressPct={progressPct}
                    hoverPct={seekHoverPct}
                    levels={waveformLevels}
                    mode={compactMode}
                  />
                  <input
                    type="range"
                    min={0}
                    max={currentTrack?.duration ?? 0}
                    value={positionMs}
                    onChange={(e) => seekTo(parseFloat(e.target.value))}
                    className="absolute inset-0 h-full w-full opacity-0"
                    aria-label="Seek"
                  />
                </div>
                <div className="text-[0.688rem] text-white text-opacity-70">
                  {formatMs(currentTrack?.duration ?? 0)}
                </div>
              </div>
            </div>

            {/* Right: queue toggle + volume + extra controls */}
            <div ref={volumeAreaRef} className="flex w-[30%] min-w-[11.25rem] items-center justify-end gap-1">

              {/* Radio mode indicator — click to turn off auto-refill */}
              {isRadioMode && (
                <button
                  onClick={stopRadio}
                  title="Radio is on — click to stop"
                  className="mr-1 flex-shrink-0 flex items-center gap-1 rounded-full bg-accent/15 border border-accent/30 px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-accent hover:bg-accent/30 transition-colors"
                >
                  <svg viewBox="0 0 16 16" width="8" height="8" fill="currentColor">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                  </svg>
                  {djMode ? (DJ_MODES.find(d => d.key === djMode)?.name.replace('DJ ', '') ?? 'DJ') : 'Radio'}
                </button>
              )}

              {/* Track info */}
              <button
                onClick={() => currentTrack && setTrackInfoOpen(v => !v)}
                title="Track info"
                className={`flex-shrink-0 flex h-8 w-8 items-center justify-center transition-colors ${trackInfoOpen ? "text-accent" : "text-white/40 hover:text-white/70"}`}
                aria-label="Track info"
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                  <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
                </svg>
              </button>

              {/* Guest DJ menu — click headphones to open DJ personality picker */}
              <div className="relative flex flex-col items-center flex-shrink-0">
                <button
                  ref={djButtonRef}
                  onClick={() => {
                    const rect = djButtonRef.current?.getBoundingClientRect()
                    if (rect) setDjMenuPos({ bottom: window.innerHeight - rect.top + 8, right: window.innerWidth - rect.right })
                    setDjMenuOpen(v => !v)
                  }}
                  title="Guest DJ"
                  className={`flex h-8 w-8 items-center justify-center transition-colors ${djMode ? "text-accent" : "text-white/40 hover:text-white/70"}`}
                  aria-label="Guest DJ"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                    <path d="M8 1a6 6 0 0 0-6 6v2.5a2.5 2.5 0 0 0 2.5 2.5H5a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1H3.05A5 5 0 0 1 13 7H11a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h.5A2.5 2.5 0 0 0 14 9.5V7a6 6 0 0 0-6-6z" />
                  </svg>
                </button>
                {djMode && (
                  <span className="absolute top-full mt-0.5 text-[0.5625rem] leading-none font-medium text-accent whitespace-nowrap pointer-events-none">
                    {DJ_MODES.find(d => d.key === djMode)?.name.replace('DJ ', '')}
                  </span>
                )}

                {djMenuOpen && djMenuPos && (
                  <>
                    <div className="fixed inset-0 z-[200]" onClick={() => setDjMenuOpen(false)} />
                    <div
                      className="fixed z-[201] w-72 rounded-xl bg-app-card border border-[var(--border)] shadow-2xl py-2"
                      style={{ bottom: djMenuPos.bottom, right: djMenuPos.right }}
                    >
                      <div className="px-3 pb-1.5 text-[0.625rem] font-semibold uppercase tracking-widest text-gray-500">Guest DJ</div>
                      {DJ_MODES.map(dj => (
                        <button
                          key={dj.key}
                          onClick={() => { setDjMode(djMode === dj.key ? null : dj.key as DjMode); setDjMenuOpen(false) }}
                          className={`w-full text-left px-3 py-2 hover:bg-app-surface-hover transition-colors ${djMode === dj.key ? "bg-app-surface" : ""}`}
                        >
                          <div className={`flex items-center gap-2 text-sm font-medium ${djMode === dj.key ? "text-accent" : "text-white"}`}>
                            {djMode === dj.key ? (
                              <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" className="flex-shrink-0">
                                <path d="M13.78 3.22a.75.75 0 0 1 0 1.06l-8 8a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06L5.25 10.69l7.47-7.47a.75.75 0 0 1 1.06 0z"/>
                              </svg>
                            ) : (
                              <span className="w-[10px] flex-shrink-0" />
                            )}
                            {dj.name}
                          </div>
                          <div className="text-xs text-gray-500 pl-[18px] mt-0.5">{dj.desc}</div>
                        </button>
                      ))}
                      {djMode && (
                        <div className="border-t border-[var(--border)] mt-1 pt-1">
                          <button
                            onClick={() => { setDjMode(null); setDjMenuOpen(false) }}
                            className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:text-white transition-colors"
                          >
                            Turn off Guest DJ
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Sleep timer toggle */}
              <div className="relative flex flex-col items-center flex-shrink-0">
                <button
                  onClick={() => setSleepTimerOpen(v => !v)}
                  title="Sleep Timer"
                  className={`flex h-8 w-8 items-center justify-center transition-colors ${sleepEndsAt ? "text-accent" : "text-white/40 hover:text-white/70"}`}
                  aria-label="Sleep Timer"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                    <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/>
                  </svg>
                </button>
                {sleepRemaining && (
                  <span className="absolute top-full mt-0.5 text-[0.5625rem] leading-none font-medium text-accent whitespace-nowrap pointer-events-none">
                    {sleepRemaining}
                  </span>
                )}
              </div>

              {/* Lyrics toggle */}
              <button
                onClick={() => {
                  if (isQueuePinned) {
                    // When queue is pinned, lyrics live in the queue panel as a tab
                    if (!isQueueOpen || queueActiveTab !== "lyrics") {
                      setQueueOpen(true)
                      setQueueActiveTab("lyrics")
                    } else {
                      setQueueActiveTab("queue")
                    }
                  } else {
                    setLyricsOpen(!isLyricsOpen)
                  }
                }}
                title="Lyrics"
                className={`flex-shrink-0 flex h-8 w-8 items-center justify-center transition-colors ${
                  (isQueuePinned ? isQueueOpen && queueActiveTab === "lyrics" : isLyricsOpen) || lyricsLines !== null
                    ? "text-accent"
                    : "text-white/40 hover:text-white/70"
                }`}
                aria-label="Lyrics"
              >
                {/* Microphone icon */}
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0v-5A2.5 2.5 0 0 0 8 1z"/>
                  <path d="M3.5 8.5a.5.5 0 0 1 .5.5A4 4 0 0 0 12 9a.5.5 0 0 1 1 0 5 5 0 0 1-4.5 4.975V15.5a.5.5 0 0 1-1 0v-1.525A5 5 0 0 1 3 9a.5.5 0 0 1 .5-.5z"/>
                </svg>
              </button>

              {/* Visualizer mode cycle */}
              <button
                onClick={cycleCompactMode}
                title={`Visualizer: ${compactMode}`}
                className="flex-shrink-0 flex h-8 w-8 items-center justify-center transition-colors text-white/40 hover:text-white/70"
                aria-label="Cycle visualizer mode"
              >
                {/* Waveform/spectrum icon — changes subtly per mode */}
                {compactMode === "waveform" && (
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                    <path d="M0 8a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1A.5.5 0 0 1 0 9V8zm3-3a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-1A.5.5 0 0 1 3 9V5zm3-2a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-1A.5.5 0 0 1 6 11V3zm3 2a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-1A.5.5 0 0 1 9 9V5zm3 3a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5V8z"/>
                  </svg>
                )}
                {compactMode === "spectrum" && (
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                    <path d="M1 13v-2h2v2H1zm3-2h2v2H4v-2zm3-2h2v4H7V9zm3-2h2v6h-2V7zm3-4h2v10h-2V3z"/>
                  </svg>
                )}
                {compactMode === "oscilloscope" && (
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                    <path d="M0 8c0-.18.1-.34.25-.42l3-1.6a.5.5 0 0 1 .5.87L1.5 8l2.25 1.15a.5.5 0 0 1-.5.87l-3-1.6A.5.5 0 0 1 0 8zm16 0a.5.5 0 0 1-.25.42l-3 1.6a.5.5 0 1 1-.5-.87L14.5 8l-2.25-1.15a.5.5 0 1 1 .5-.87l3 1.6c.15.08.25.24.25.42zM5.5 4a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5zm2.5 2a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-1 0v-3A.5.5 0 0 1 8 6zm2.5-2a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5z"/>
                  </svg>
                )}
                {compactMode === "vu" && (
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                    <path d="M1 11a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-3zm5-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7zm5-5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V2z"/>
                  </svg>
                )}
              </button>

              {/* Fullscreen visualizer expand */}
              <button
                onClick={openFullscreen}
                title="Open fullscreen visualizer"
                className="flex-shrink-0 flex h-8 w-8 items-center justify-center transition-colors text-white/40 hover:text-white/70"
                aria-label="Open fullscreen visualizer"
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <path d="M1.5 1h4a.5.5 0 0 1 0 1H2v3.5a.5.5 0 0 1-1 0v-4A.5.5 0 0 1 1.5 1zm9 0h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V2h-3.5a.5.5 0 0 1 0-1zm-9 9a.5.5 0 0 1 .5.5V14h3.5a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5v-4a.5.5 0 0 1 .5-.5zm13 0a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-4a.5.5 0 0 1 0-1H14v-3.5a.5.5 0 0 1 .5-.5z"/>
                </svg>
              </button>

              {/* EQ toggle */}
              <button
                onClick={() => setEqOpen(!isEqOpen)}
                title="Equalizer"
                className={`flex-shrink-0 flex h-8 w-8 items-center justify-center transition-colors ${isEqOpen || eqEnabled ? "text-accent" : "text-white/40 hover:text-white/70"}`}
                aria-label="Equalizer"
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <rect x="1"  y="6" width="2" height="8" rx="1"/>
                  <rect x="4"  y="3" width="2" height="11" rx="1"/>
                  <rect x="7"  y="1" width="2" height="13" rx="1"/>
                  <rect x="10" y="4" width="2" height="10" rx="1"/>
                  <rect x="13" y="7" width="2" height="7" rx="1"/>
                </svg>
              </button>

              {/* Queue toggle */}
              <button
                onClick={() => setQueueOpen(!isQueueOpen)}
                className={`flex-shrink-0 mr-1 flex h-8 w-8 items-center justify-center transition-colors ${isQueueOpen ? "text-accent" : "text-white/40 hover:text-white/70"}`}
                aria-label="Queue"
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <path d="M15 15H1v-1.5h14V15zm0-4.5H1V9h14v1.5zm-14-7A2.5 2.5 0 0 1 3.5 1h9a2.5 2.5 0 0 1 0 5h-9A2.5 2.5 0 0 1 1 3.5zm2.5-1a1 1 0 0 0 0 2h9a1 1 0 0 0 0-2h-9z" />
                </svg>
              </button>

              {/* Volume icon — muted / low / full */}
              <button onClick={() => setVolume(volume === 0 ? 80 : 0)} className="flex-shrink-0 flex h-8 w-8 items-center justify-center text-white/70 hover:text-white transition-colors">
                {volume === 0 ? (
                  <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M13.86 5.47a.75.75 0 0 0-1.061 0l-1.47 1.47-1.47-1.47A.75.75 0 0 0 8.8 6.53L10.269 8l-1.47 1.47a.75.75 0 1 0 1.06 1.06l1.47-1.47 1.47 1.47a.75.75 0 0 0 1.06-1.06L12.39 8l1.47-1.47a.75.75 0 0 0 0-1.06z" />
                    <path d="M10.116 1.5A.75.75 0 0 0 8.991.85l-6.925 4a3.642 3.642 0 0 0-1.33 4.967 3.639 3.639 0 0 0 1.33 1.332l6.925 4a.75.75 0 0 0 1.125-.649v-13a.75.75 0 0 0-.002-.001zm0 12.34L3.322 9.688a2.14 2.14 0 0 1 0-3.7l6.794-3.99v11.84z" />
                  </svg>
                ) : volume < 50 ? (
                  <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.642 3.642 0 0 1-1.33-4.967 3.639 3.639 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 .75 0zm-6.924 5.3a2.139 2.139 0 0 0 0 3.7l5.8 3.35V2.8l-5.8 3.35zm8.683 4.21v-4.2a2.447 2.447 0 0 1 0 4.2z" />
                  </svg>
                ) : (
                  <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.642 3.642 0 0 1-1.33-4.967 3.639 3.639 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 .75 0zm-6.924 5.3a2.139 2.139 0 0 0 0 3.7l5.8 3.35V2.8l-5.8 3.35zm8.683 6.087a4.502 4.502 0 0 0 0-8.474v1.65a2.999 2.999 0 0 1 0 5.175v1.649z" />
                  </svg>
                )}
              </button>
              <div className="flex h-7 w-32 items-center">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={volume}
                  onChange={e => setVolume(parseInt(e.target.value, 10))}
                  className="h-1 w-full cursor-pointer appearance-none rounded-full"
                  style={{
                    background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${volume}%, #535353 ${volume}%, #535353 100%)`,
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
