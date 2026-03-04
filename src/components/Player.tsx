import { useEffect, useRef, useState } from "react"
import { Link } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores"
import { DJ_MODES } from "../stores/playerStore"
import { useUIStore } from "../stores/uiStore"
import { useEqStore } from "../stores/eqStore"
import { useAudioSettingsStore } from "../stores/audioSettingsStore"
import { useVisualizerStore } from "../stores/visualizerStore"
import { audioSetCacheMaxBytes, audioSetVisualizerEnabled } from "../lib/audio"
import { formatMs } from "../lib/formatters"
import { IconBlockquote, IconZzz, IconActivity, IconMaximize, IconAdjustments, IconPlaylist, IconVolume, IconVolume2, IconVolumeOff, IconHeadphones, IconArrowsCross } from "@tabler/icons-react"
import { useCapability } from "../hooks/useCapability"
import { useLongPress } from "../hooks/useLongPress"
import EqPanel from "./EqPanel"
import SleepTimerPanel from "./SleepTimerPanel"
import TrackInfoPanel from "./TrackInfoPanel"
import DjPanel from "./DjPanel"
import RadioPanel from "./RadioPanel"
import PlayerPopover from "./PlayerPopover"
import VisualizerCanvas from "./VisualizerCanvas"
import { StarRating } from "./shared/StarRating"
import VisualizerFullscreen from "./VisualizerFullscreen"
import SquigglyVolumeSlider from "./SquigglyVolumeSlider"
import { useSleepTimerStore } from "../stores/sleepTimerStore"
import { useRadioStreamStore } from "../stores/radioStreamStore"
import { useEasterEggs } from "../hooks/useEasterEggs"
import { useEasterEggStore } from "../stores/easterEggStore"
import { ImageModal } from "./shared/ImageModal"
import { IconChevronUp, IconChevronDown } from "@tabler/icons-react"

const CACHE_SIZE_KEY = "plexify-audio-cache-max-bytes"

// ---------------------------------------------------------------------------
// RadioPlayerBar — shown when internet radio is active
// ---------------------------------------------------------------------------

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return ""
  return String.fromCodePoint(
    ...code.toUpperCase().split("").map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
  )
}

function RadioPlayerBar() {
  const volumeSliderRef = useRef<HTMLDivElement>(null)
  const volumeTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [volumeTooltipVisible, setVolumeTooltipVisible] = useState(false)

  const { currentStation, isStreamPlaying, isStreamBuffering, streamError, stopStream, pauseStream, resumeStream } =
    useRadioStreamStore(useShallow(s => ({
      currentStation: s.currentStation,
      isStreamPlaying: s.isStreamPlaying,
      isStreamBuffering: s.isStreamBuffering,
      streamError: s.streamError,
      stopStream: s.stopStream,
      pauseStream: s.pauseStream,
      resumeStream: s.resumeStream,
    })))

  const { volume, setVolume } = usePlayerStore(useShallow(s => ({
    volume: s.volume,
    setVolume: s.setVolume,
  })))

  // Media session metadata for internet radio
  useEffect(() => {
    if (!navigator.mediaSession || !currentStation) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentStation.name,
      artist: currentStation.tags.slice(0, 2).join(", ") || "Internet Radio",
    })
    navigator.mediaSession.playbackState = isStreamPlaying ? "playing" : "paused"
  }, [currentStation?.uuid, isStreamPlaying])

  // Media session action handlers for radio
  useEffect(() => {
    if (!navigator.mediaSession) return
    navigator.mediaSession.setActionHandler("play", () => resumeStream())
    navigator.mediaSession.setActionHandler("pause", () => pauseStream())
    navigator.mediaSession.setActionHandler("stop", () => stopStream())
    return () => {
      for (const a of ["play", "pause", "stop"] as const)
        navigator.mediaSession.setActionHandler(a, null)
    }
  }, [])

  // Scroll wheel volume
  useEffect(() => {
    const el = volumeSliderRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY < 0 ? 2.5 : -2.5
      setVolume(usePlayerStore.getState().volume + delta)
      setVolumeTooltipVisible(true)
      if (volumeTooltipTimer.current) clearTimeout(volumeTooltipTimer.current)
      volumeTooltipTimer.current = setTimeout(() => setVolumeTooltipVisible(false), 1500)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  if (!currentStation) return null

  const tags = currentStation.tags.slice(0, 3)
  const codecLabel = [currentStation.codec, currentStation.bitrate > 0 ? `${currentStation.bitrate}k` : ""]
    .filter(Boolean).join(" ")

  return (
    <div className="relative border-t border-[var(--border)] bg-app-card">
      {streamError && (
        <div className="absolute bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-red-900/90 px-4 py-2 text-sm text-white shadow-xl backdrop-blur-sm max-w-md text-center">
          {streamError}
        </div>
      )}
      <div className="flex h-fit w-screen min-w-[620px] flex-col overflow-clip bg-app-card">
        <div className="h-24">
          <div className="flex h-full items-center justify-between px-4">

            {/* Left: station info */}
            <div className="w-[30%] min-w-[11.25rem]">
              <div className="flex items-center">
                <div className="mr-3 h-14 w-14 flex-shrink-0 rounded-lg overflow-hidden bg-app-surface flex items-center justify-center">
                  {currentStation.favicon ? (
                    <img src={currentStation.favicon} alt="" className="h-full w-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = "none" }} />
                  ) : (
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" className="text-white/30">
                      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                    </svg>
                  )}
                </div>
                <div className="min-w-0">
                  <h6 className="line-clamp-1 text-sm font-medium text-white">{currentStation.name}</h6>
                  <p className="truncate text-[0.688rem] text-white/50 mt-0.5">
                    {currentStation.country && <>{countryFlag(currentStation.country_code)} {currentStation.country}</>}
                  </p>
                  {tags.length > 0 && (
                    <div className="mt-0.5 flex gap-1">
                      {tags.map(t => (
                        <span key={t} className="rounded-full bg-white/5 px-1.5 py-0 text-[0.5625rem] text-white/30">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Center: play/pause + LIVE indicator */}
            <div className="flex w-[40%] max-w-[45.125rem] flex-col items-center px-4 pt-2">
              <div className="flex items-center gap-x-3">
                {/* Play/Pause */}
                <button
                  onClick={isStreamPlaying ? pauseStream : resumeStream}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-base)] hover:scale-[1.06]"
                >
                  {isStreamPlaying ? (
                    <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z" />
                    </svg>
                  ) : (
                    <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z" />
                    </svg>
                  )}
                </button>
              </div>

              {/* Live indicator bar */}
              <div className="mt-3 flex w-full items-center justify-center gap-3">
                {isStreamBuffering ? (
                  <span className="text-xs text-white/40 animate-pulse">Buffering...</span>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 py-0.5 text-[0.6875rem] font-bold uppercase text-red-400">
                      <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                      LIVE
                    </span>
                    {codecLabel && (
                      <span className="rounded-full bg-white/5 px-2 py-0.5 text-[0.6875rem] font-mono text-white/30">
                        {codecLabel}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Right: volume + stop */}
            <div className="flex w-[30%] min-w-[11.25rem] items-center justify-end gap-1">
              {/* Stop Radio button */}
              <button
                onClick={stopStream}
                className="mr-2 flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:bg-white/10 hover:text-white"
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                  <rect x="3" y="3" width="10" height="10" rx="1" />
                </svg>
                Stop Radio
              </button>

              {/* Volume icon */}
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
              {/* Volume slider */}
              <div ref={volumeSliderRef} className="relative flex h-7 w-32 items-center">
                {volumeTooltipVisible && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 rounded-md bg-app-card border border-[var(--border)] text-xs font-bold text-white shadow-lg pointer-events-none whitespace-nowrap">
                    {Math.round(volume)}%
                  </div>
                )}
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={volume}
                  onChange={e => {
                    setVolume(parseInt(e.target.value, 10))
                    setVolumeTooltipVisible(true)
                    if (volumeTooltipTimer.current) clearTimeout(volumeTooltipTimer.current)
                    volumeTooltipTimer.current = setTimeout(() => setVolumeTooltipVisible(false), 1500)
                  }}
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

export function Player() {
  useEasterEggs()
  const vinylSpin = useEasterEggStore(s => s.vinylSpin)
  const volumeSliderRef = useRef<HTMLDivElement>(null)
  const volumeTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [seekHoverPct, setSeekHoverPct] = useState<number | null>(null)
  const [volumeTooltipVisible, setVolumeTooltipVisible] = useState(false)

  // positionMs updates at ~4 Hz — isolate it as a primitive selector so only
  // the progress bar re-renders on each tick, not the entire Player subtree.
  const positionMs = usePlayerStore(s => s.positionMs)

  const {
    currentTrack,
    isPlaying,
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
    isInternetRadioActive,
    pause,
    resume,
    next,
    prev,
    seekTo,
    setVolume,
    toggleShuffle,
    cycleRepeat,
    stop,
    stopRadio,
    initAudioEvents,
  } = usePlayerStore(useShallow(s => ({
    currentTrack: s.currentTrack,
    isPlaying: s.isPlaying,
    volume: s.volume,
    shuffle: s.shuffle,
    repeat: s.repeat,
    isRadioMode: s.isRadioMode,
    djMode: s.djMode,
    playerError: s.playerError,
    contextName: s.contextName,
    contextHref: s.contextHref,
    waveformLevels: s.waveformLevels,
    lyricsLines: s.lyricsLines,
    isInternetRadioActive: s.isInternetRadioActive,
    pause: s.pause,
    resume: s.resume,
    next: s.next,
    prev: s.prev,
    seekTo: s.seekTo,
    setVolume: s.setVolume,
    toggleShuffle: s.toggleShuffle,
    cycleRepeat: s.cycleRepeat,
    stop: s.stop,
    stopRadio: s.stopRadio,
    initAudioEvents: s.initAudioEvents,
  })))

  const { compactMode, cycleCompactMode, openFullscreen, fullscreenOpen } = useVisualizerStore(
    useShallow(s => ({
      compactMode: s.compactMode,
      cycleCompactMode: s.cycleCompactMode,
      openFullscreen: s.openFullscreen,
      fullscreenOpen: s.fullscreenOpen,
    }))
  )

  const [sleepRemaining, setSleepRemaining] = useState<string | null>(null)
  const { endsAt: sleepEndsAt, hydrate: hydrateSleepTimer } = useSleepTimerStore(useShallow(s => ({ endsAt: s.endsAt, hydrate: s.hydrate })))

  const {
    isQueueOpen, setQueueOpen,
    isQueuePinned, queueActiveTab, setQueueActiveTab,
    isLyricsOpen, setLyricsOpen,
    isArtExpanded, toggleArtExpanded,
  } = useUIStore(useShallow(s => ({
    isQueueOpen: s.isQueueOpen,
    setQueueOpen: s.setQueueOpen,
    isQueuePinned: s.isQueuePinned,
    queueActiveTab: s.queueActiveTab,
    setQueueActiveTab: s.setQueueActiveTab,
    isLyricsOpen: s.isLyricsOpen,
    setLyricsOpen: s.setLyricsOpen,
    isArtExpanded: s.isArtExpanded,
    toggleArtExpanded: s.toggleArtExpanded,
  })))
  const { enabled: eqEnabled, syncToEngine } = useEqStore(useShallow(s => ({ enabled: s.enabled, syncToEngine: s.syncToEngine })))
  const { crossfadeStyle, crossfadeWindowMs: cfWindowMs, setCrossfadeStyle } = useAudioSettingsStore(
    useShallow(s => ({ crossfadeStyle: s.crossfadeStyle, crossfadeWindowMs: s.crossfadeWindowMs, setCrossfadeStyle: s.setCrossfadeStyle }))
  )
  const syncAudioSettings = useAudioSettingsStore(s => s.syncToEngine)
  const hasRadio = useCapability("radio")
  const hasDjModes = useCapability("djModes")
  const hasLyrics = useCapability("lyrics")

  const [showImageModal, setShowImageModal] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("plex-sidebar-width")
    return saved ? parseInt(saved, 10) || 240 : 240
  })

  // Track sidebar width changes via custom event from useResizable
  useEffect(() => {
    const onResize = (e: Event) => {
      const { key, width: w } = (e as CustomEvent).detail
      if (key === "plex-sidebar-width") setSidebarWidth(w)
    }
    window.addEventListener("resizable-change", onResize)
    return () => window.removeEventListener("resizable-change", onResize)
  }, [])

  const playPauseLongPress = useLongPress({
    onPress: () => { isPlaying ? pause() : resume() },
    onLongPress: stop,
  })

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

  // Gate PCM bridge — only run when a live-data visualizer mode or party mode is active
  const partyMode = useEasterEggStore(s => s.partyMode)
  useEffect(() => {
    const needsPcm = compactMode !== "waveform" || fullscreenOpen || partyMode
    void audioSetVisualizerEnabled(needsPcm).catch(() => {})
  }, [compactMode, fullscreenOpen, partyMode])

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
        artist: currentTrack.artistName,
        album: currentTrack.albumName,
      })
    }
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused"
  }, [currentTrack?.id, isPlaying])

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

  // Scroll wheel on volume slider — must be non-passive to call preventDefault()
  useEffect(() => {
    const el = volumeSliderRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // deltaY < 0 = scroll up = louder; each notch ≈ 2.5 units
      const delta = e.deltaY < 0 ? 2.5 : -2.5
      // Read latest volume directly from store (avoids stale closure)
      setVolume(usePlayerStore.getState().volume + delta)
      setVolumeTooltipVisible(true)
      if (volumeTooltipTimer.current) clearTimeout(volumeTooltipTimer.current)
      volumeTooltipTimer.current = setTimeout(() => setVolumeTooltipVisible(false), 1500)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  const thumbUrl = currentTrack?.thumbUrl ?? null

  const artistId = currentTrack?.artistId
  const albumId = currentTrack?.albumId

  const progressPct = currentTrack?.duration
    ? (positionMs / currentTrack.duration) * 100
    : 0

  const repeatActive = repeat > 0
  const shuffleActive = shuffle

  // Only show album in the subtitle row when contextName isn't already showing the same album
  const showAlbumInSubtitle = !!(
    currentTrack?.albumName && albumId &&
    (!contextName || contextName !== currentTrack.albumName)
  )

  // Media info chip: codec + bitrate shown next to the repeat button.
  const chipCodec = currentTrack?.codec?.toUpperCase() ?? null
  const chipBitrate = currentTrack?.bitrate
  const mediaLabel = chipCodec
    ? chipBitrate ? `${chipCodec} ${chipBitrate}k` : chipCodec
    : null

  // Short DJ name (strip "DJ " prefix) for inline display
  const djShortName = djMode ? DJ_MODES.find(d => d.key === djMode)?.name.replace("DJ ", "") ?? djMode : null

  // Crossfade style labels & cycling
  const CROSSFADE_STYLES = [
    { value: 0, short: "Smooth", label: "Smooth crossfade" },
    { value: 1, short: "Filter", label: "DJ Filter crossfade" },
    { value: 2, short: "Echo", label: "Echo Out crossfade" },
    { value: 3, short: "Cut", label: "Hard Cut crossfade" },
  ] as const
  const cfStyleInfo = CROSSFADE_STYLES.find(s => s.value === crossfadeStyle) ?? CROSSFADE_STYLES[0]
  const cfActive = crossfadeStyle !== 0 && cfWindowMs > 0

  // When internet radio is active, show the radio-specific player bar
  if (isInternetRadioActive) return <RadioPlayerBar />

  return (
    <div className="relative border-t border-[var(--border)] bg-app-card">
      {/* Expanded album art — fixed to bottom-left corner, overlaps sidebar area */}
      {isArtExpanded && thumbUrl && (
        <div
          className="group/expanded fixed bottom-0 left-0 z-30"
          style={{ width: sidebarWidth, height: sidebarWidth }}
        >
          <Link
            href={albumId ? `/album/${albumId}` : "#"}
            className={`block h-full w-full overflow-hidden ${albumId ? "cursor-pointer" : "cursor-default"} ${vinylSpin ? "rounded-full" : ""}`}
            style={vinylSpin ? {
              animation: "vinyl-spin 3s linear infinite",
              animationPlayState: isPlaying ? "running" : "paused",
            } : undefined}
            onClick={e => { if (!albumId) e.preventDefault() }}
          >
            <img src={thumbUrl} alt={currentTrack?.albumName ?? ""} className="h-full w-full object-cover" />
          </Link>
          {/* Hover overlay buttons — bottom-right */}
          <div className="pointer-events-none absolute inset-0 flex items-end justify-end gap-1 opacity-0 transition-opacity group-hover/expanded:opacity-100 p-1.5">
            <button
              onClick={e => { e.stopPropagation(); e.preventDefault(); toggleArtExpanded() }}
              className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-sm bg-black/70 text-white/80 hover:text-white hover:bg-black/90 transition-colors"
              title="Collapse art"
            >
              <IconChevronDown size={16} stroke={2} />
            </button>
            <button
              onClick={e => { e.stopPropagation(); e.preventDefault(); setShowImageModal(true) }}
              className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-sm bg-black/70 text-white/80 hover:text-white hover:bg-black/90 transition-colors"
              title="View full size"
            >
              <IconMaximize size={14} stroke={2} />
            </button>
          </div>
        </div>
      )}

      {/* Fullscreen image modal */}
      {showImageModal && thumbUrl && (
        <ImageModal
          src={thumbUrl}
          alt={currentTrack?.albumName ?? "Album art"}
          onClose={() => setShowImageModal(false)}
        />
      )}

      {/* Error toast — shown briefly when playRadio or other player actions fail */}
      {playerError && (
        <div className="absolute bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-red-900/90 px-4 py-2 text-sm text-white shadow-xl backdrop-blur-sm max-w-md text-center">
          {playerError}
        </div>
      )}
      {fullscreenOpen && <VisualizerFullscreen />}
      <div className="flex h-fit w-screen min-w-[620px] flex-col overflow-clip bg-app-card">
        <div className="h-24">
          <div className="flex h-full items-center justify-between px-4">

            {/* Left: current track info */}
            <div
              className="min-w-[11.25rem] transition-all duration-300"
              style={isArtExpanded && thumbUrl
                ? { width: `calc(30% + ${sidebarWidth - 80}px)`, paddingLeft: sidebarWidth }
                : { width: "30%" }
              }
            >
              <div className="flex items-center">
                <div className="mr-3 flex items-center">
                  <div className={`group/art relative mr-3 h-14 w-14 flex-shrink-0 ${isArtExpanded && thumbUrl ? "hidden" : ""}`}>
                    {/* Album art — click navigates to album */}
                    <Link
                      href={albumId ? `/album/${albumId}` : "#"}
                      className={`block h-full w-full overflow-hidden ${albumId ? "cursor-pointer" : "cursor-default"} ${vinylSpin ? "rounded-full" : ""}`}
                      style={vinylSpin ? {
                        animation: "vinyl-spin 3s linear infinite",
                        animationPlayState: isPlaying ? "running" : "paused",
                      } : undefined}
                      onClick={e => { if (!albumId) e.preventDefault() }}
                    >
                      {thumbUrl ? (
                        <img src={thumbUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="h-full w-full bg-app-surface" />
                      )}
                    </Link>
                    {/* Hover overlay buttons — bottom-right */}
                    {thumbUrl && (
                      <div className="pointer-events-none absolute inset-0 flex items-end justify-end gap-0.5 opacity-0 transition-opacity group-hover/art:opacity-100 p-0.5">
                        <button
                          onClick={e => { e.stopPropagation(); e.preventDefault(); toggleArtExpanded() }}
                          className="pointer-events-auto flex h-5 w-5 items-center justify-center rounded-sm bg-black/70 text-white/80 hover:text-white hover:bg-black/90 transition-colors"
                          title={isArtExpanded ? "Collapse art" : "Expand art"}
                        >
                          {isArtExpanded ? <IconChevronDown size={14} stroke={2} /> : <IconChevronUp size={14} stroke={2} />}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); e.preventDefault(); setShowImageModal(true) }}
                          className="pointer-events-auto flex h-5 w-5 items-center justify-center rounded-sm bg-black/70 text-white/80 hover:text-white hover:bg-black/90 transition-colors"
                          title="View full size"
                        >
                          <IconMaximize size={12} stroke={2} />
                        </button>
                      </div>
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
                          {currentTrack?.artistName ?? ""}
                        </Link>
                      ) : (currentTrack?.artistName ?? "")}
                      {showAlbumInSubtitle && (
                        <>
                          <span className="mx-1 text-white/30">·</span>
                          <Link href={`/album/${albumId}`} className="hover:text-white hover:underline transition-colors">
                            {currentTrack!.albumName}
                          </Link>
                        </>
                      )}
                    </p>
                    {currentTrack && (
                      <div className="flex items-center gap-2 mt-0.5">
                        {contextName && (
                          <p className="text-[0.625rem] text-white/35 truncate">
                            {contextHref ? (
                              <Link href={contextHref} className="hover:text-white/60 hover:underline transition-colors">
                                {contextName}
                              </Link>
                            ) : (
                              contextName
                            )}
                          </p>
                        )}
                        <div className="flex-shrink-0">
                          <StarRating
                            itemId={currentTrack.id}
                            userRating={currentTrack.userRating}
                            artist={currentTrack.artistName}
                            track={currentTrack.title}
                            size={11}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Center: controls + progress */}
            <div className="flex w-[40%] max-w-[45.125rem] flex-col items-center px-4 pt-2">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center w-full">
                {/* Left wing: radio, shuffle */}
                <div className="flex items-center justify-end gap-x-1.5">

                {/* Radio mode indicator */}
                {hasRadio && isRadioMode && (
                  <PlayerPopover
                    icon={
                      <span className="text-[0.625rem] font-bold uppercase tracking-wider">RADIO</span>
                    }
                    wide
                    active
                    label="Radio settings"
                    width={360}
                    align="left"
                  >
                    {(close) => <RadioPanel onClose={close} />}
                  </PlayerPopover>
                )}

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

                </div>

                {/* Center: prev / play-pause / next — FIXED position, never shifts */}
                <div className="flex items-center gap-x-1.5 px-1.5">
                {/* Prev */}
                <button
                  onClick={prev}
                  className="flex h-8 w-8 items-center justify-center text-white text-opacity-70 hover:text-opacity-100"
                >
                  <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.575a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7h1.6z" />
                  </svg>
                </button>

                {/* Play/Pause — long-press to stop & clear queue */}
                <button
                  {...playPauseLongPress}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-base)] hover:scale-[1.06] select-none"
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

                </div>

                {/* Right wing: repeat, media info */}
                <div className="flex items-center justify-start gap-x-1.5">
                {/* Repeat */}
                <button
                  onClick={cycleRepeat}
                  title={repeat === 0 ? "Repeat off" : repeat === 1 ? "Repeat one" : "Repeat all"}
                  className={`relative flex h-8 w-8 items-center justify-center transition-colors ${repeatActive ? "text-accent" : "text-white text-opacity-70 hover:text-opacity-100"}`}
                >
                  <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h8.5A3.75 3.75 0 0 1 16 4.75v5a3.75 3.75 0 0 1-3.75 3.75H9.81l1.018 1.018a.75.75 0 1 1-1.06 1.06L6.939 12.75l2.829-2.828a.75.75 0 1 1 1.06 1.06L9.811 12h2.439a2.25 2.25 0 0 0 2.25-2.25v-5a2.25 2.25 0 0 0-2.25-2.25h-8.5A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5z" />
                  </svg>
                  {repeat === 1 && (
                    <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-[8px] font-bold text-black">1</span>
                  )}
                  {repeat === 2 && (
                    <span className="absolute -top-0.5 -right-1.5 flex h-3.5 w-auto min-w-[14px] px-0.5 items-center justify-center rounded-full bg-accent text-[7px] font-bold text-black">ALL</span>
                  )}
                </button>

                {/* Track info — plain text quality label, clickable */}
                {currentTrack && mediaLabel && (
                  <PlayerPopover
                    icon={
                      <span className="font-mono text-[0.625rem] font-medium tracking-wide">{mediaLabel}</span>
                    }
                    label="Track info"
                    align="center"
                    width="auto"
                  >
                    {(close) => <TrackInfoPanel onClose={close} />}
                  </PlayerPopover>
                )}

                {/* Guest DJ — icon only when inactive, icon+name pill when active */}
                {hasDjModes && <PlayerPopover
                  icon={
                    djMode ? (
                      <>
                        <IconHeadphones size={14} stroke={1.5} />
                        <span className="text-[0.6875rem] font-semibold">{djShortName}</span>
                      </>
                    ) : (
                      <IconHeadphones size={18} stroke={1.5} />
                    )
                  }
                  wide={!!djMode}
                  active={!!djMode}
                  label="Guest DJ"
                  width={288}
                >
                  {(close) => <DjPanel onClose={close} />}
                </PlayerPopover>}

                {/* Crossfade style — cycle through Smooth/Filter/Echo/Cut */}
                {cfWindowMs > 0 && (
                  <button
                    onClick={() => setCrossfadeStyle((crossfadeStyle + 1) % 4)}
                    title={cfStyleInfo.label}
                    className={`flex items-center gap-1 rounded-full transition-colors ${
                      cfActive
                        ? "bg-accent/15 px-2.5 h-7 text-accent"
                        : "h-8 w-8 justify-center text-white/40 hover:text-white/70"
                    }`}
                  >
                    <IconArrowsCross size={cfActive ? 14 : 18} stroke={1.5} />
                    {cfActive && (
                      <span className="text-[0.6875rem] font-semibold">{cfStyleInfo.short}</span>
                    )}
                  </button>
                )}

                {/* Lyrics — only shown when lyrics are available */}
                {hasLyrics && lyricsLines !== null && (
                  <button
                    onClick={() => {
                      if (isQueuePinned) {
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
                    className={`flex h-8 w-8 items-center justify-center transition-colors ${
                      (isQueuePinned ? isQueueOpen && queueActiveTab === "lyrics" : isLyricsOpen)
                        ? "text-accent"
                        : "text-white/40 hover:text-white/70"
                    }`}
                    aria-label="Lyrics"
                  >
                    <IconBlockquote size={18} stroke={1.5} />
                  </button>
                )}

                {/* Sleep timer */}
                <PlayerPopover
                  icon={
                    <IconZzz size={18} stroke={1.5} />
                  }
                  label="Sleep Timer"
                  active={!!sleepEndsAt}
                  subtitle={sleepRemaining}
                  width={224}
                >
                  {(close) => <SleepTimerPanel onClose={close} />}
                </PlayerPopover>
                </div>
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

            {/* Right: volume + extra controls */}
            <div className="flex w-[30%] min-w-[11.25rem] items-center justify-end gap-1">

              {/* Visualizer mode cycle */}
              <button
                onClick={cycleCompactMode}
                title={`Visualizer: ${compactMode}`}
                className="flex-shrink-0 flex h-8 w-8 items-center justify-center transition-colors text-white/40 hover:text-white/70"
                aria-label="Cycle visualizer mode"
              >
                <IconActivity size={18} stroke={1.5} />
              </button>

              {/* Fullscreen visualizer expand */}
              <button
                onClick={openFullscreen}
                title="Open fullscreen visualizer"
                className="flex-shrink-0 flex h-8 w-8 items-center justify-center transition-colors text-white/40 hover:text-white/70"
                aria-label="Open fullscreen visualizer"
              >
                <IconMaximize size={18} stroke={1.5} />
              </button>

              {/* EQ */}
              <PlayerPopover
                icon={
                  <IconAdjustments size={18} stroke={1.5} />
                }
                label="Equalizer"
                active={eqEnabled}
                width={460}
              >
                {(close) => <EqPanel onClose={close} />}
              </PlayerPopover>

              {/* Queue toggle */}
              <button
                onClick={() => setQueueOpen(!isQueueOpen)}
                className={`flex-shrink-0 mr-1 flex h-8 w-8 items-center justify-center transition-colors ${isQueueOpen ? "text-accent" : "text-white/40 hover:text-white/70"}`}
                aria-label="Queue"
              >
                <IconPlaylist size={18} stroke={1.5} />
              </button>

              {/* Volume icon — muted / low / full */}
              <button onClick={() => setVolume(volume === 0 ? 80 : 0)} className="flex-shrink-0 flex h-8 w-8 items-center justify-center text-white/70 hover:text-white transition-colors">
                {volume === 0 ? (
                  <IconVolumeOff size={18} stroke={1.5} />
                ) : volume < 50 ? (
                  <IconVolume2 size={18} stroke={1.5} />
                ) : (
                  <IconVolume size={18} stroke={1.5} />
                )}
              </button>
              {/* Squiggly volume slider */}
              <div ref={volumeSliderRef} className="relative flex items-center">
                {volumeTooltipVisible && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 rounded-md bg-app-card border border-[var(--border)] text-xs font-bold text-white shadow-lg pointer-events-none whitespace-nowrap">
                    {Math.round(volume)}%
                  </div>
                )}
                <SquigglyVolumeSlider
                  volume={volume}
                  onChange={v => {
                    setVolume(v)
                    setVolumeTooltipVisible(true)
                    if (volumeTooltipTimer.current) clearTimeout(volumeTooltipTimer.current)
                    volumeTooltipTimer.current = setTimeout(() => setVolumeTooltipVisible(false), 1500)
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
