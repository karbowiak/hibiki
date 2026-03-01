import { useEffect, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore, useConnectionStore, buildPlexImageUrl } from "../stores"
import { useUIStore } from "../stores/uiStore"
import { reportTimeline, audioSetCacheMaxBytes } from "../lib/plex"

const CACHE_SIZE_KEY = "plexify-audio-cache-max-bytes"

function formatMs(ms: number): string {
  if (!ms || isNaN(ms)) return "0:00"
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`
}

/**
 * Convert a 0-100 slider position to a 0.0-1.0 gain value using a cubic curve.
 * This matches human loudness perception: 50 on the slider sounds like "half volume".
 * At 50: gain ≈ 0.125 (−18 dB), at 100: gain = 1.0.
 */
function sliderToGain(slider: number): number {
  if (slider <= 0) return 0
  if (slider >= 100) return 1
  return Math.pow(slider / 100, 3)
}

export function Player() {
  const positionRef = useRef(0)
  const volumeAreaRef = useRef<HTMLDivElement>(null)

  const {
    currentTrack,
    isPlaying,
    positionMs,
    volume,
    shuffle,
    repeat,
    isRadioMode,
    guestDjEnabled,
    pause,
    resume,
    next,
    prev,
    seekTo,
    setVolume,
    toggleShuffle,
    cycleRepeat,
    toggleGuestDj,
    initAudioEvents,
  } = usePlayerStore()

  const { baseUrl, token } = useConnectionStore()
  const { isQueueOpen, setQueueOpen } = useUIStore(useShallow(s => ({ isQueueOpen: s.isQueueOpen, setQueueOpen: s.setQueueOpen })))

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
    initAudioEvents().then((fn) => {
      cleanup = fn
    })
    return () => {
      cleanup?.()
    }
  }, [])

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

  const progressPct = currentTrack?.duration
    ? (positionMs / currentTrack.duration) * 100
    : 0

  const repeatActive = repeat > 0
  const shuffleActive = shuffle

  return (
    <div className="border-t border-[#282828]">
      <div className="flex h-fit w-screen min-w-[620px] flex-col overflow-clip rounded-b-lg bg-[#181818]">
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
                      <div className="h-full w-full bg-[#282828]" />
                    )}
                  </div>
                  <div>
                    <h6 className="line-clamp-1 text-sm text-white">
                      {currentTrack?.title ?? ""}
                    </h6>
                    <p className="text-[0.688rem] text-white text-opacity-70">
                      {currentTrack?.grandparent_title ?? ""}
                    </p>
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
                  className={`flex h-8 w-8 items-center justify-center transition-colors ${shuffleActive ? "text-[#1db954]" : "text-white text-opacity-70 hover:text-opacity-100"}`}
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
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-black hover:scale-[1.06]"
                >
                  {isPlaying ? (
                    <svg role="img" height="16" width="16" viewBox="0 0 16 16">
                      <path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z" />
                    </svg>
                  ) : (
                    <svg role="img" height="16" width="16" viewBox="0 0 16 16">
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
                  className={`flex h-8 w-8 items-center justify-center transition-colors ${repeatActive ? "text-[#1db954]" : "text-white text-opacity-70 hover:text-opacity-100"}`}
                >
                  <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h8.5A3.75 3.75 0 0 1 16 4.75v5a3.75 3.75 0 0 1-3.75 3.75H9.81l1.018 1.018a.75.75 0 1 1-1.06 1.06L6.939 12.75l2.829-2.828a.75.75 0 1 1 1.06 1.06L9.811 12h2.439a2.25 2.25 0 0 0 2.25-2.25v-5a2.25 2.25 0 0 0-2.25-2.25h-8.5A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5z" />
                  </svg>
                </button>
              </div>

              {/* Progress bar */}
              <div className="mt-1.5 flex w-full items-center gap-x-2">
                <div className="text-[0.688rem] text-white text-opacity-70">
                  {formatMs(positionMs)}
                </div>
                <div className="flex h-7 w-full items-center">
                  <input
                    type="range"
                    min={0}
                    max={currentTrack?.duration ?? 0}
                    value={positionMs}
                    onChange={(e) => seekTo(parseFloat(e.target.value))}
                    className="h-1 w-full cursor-pointer appearance-none rounded-full bg-[#535353] accent-[#1db954]"
                    style={{
                      background: `linear-gradient(to right, #1db954 0%, #1db954 ${progressPct}%, #535353 ${progressPct}%, #535353 100%)`,
                    }}
                  />
                </div>
                <div className="text-[0.688rem] text-white text-opacity-70">
                  {formatMs(currentTrack?.duration ?? 0)}
                </div>
              </div>
            </div>

            {/* Right: queue toggle + volume */}
            <div ref={volumeAreaRef} className="flex w-[30%] min-w-[11.25rem] items-center justify-end gap-1">

              {/* Radio mode indicator — shown when a station is active */}
              {isRadioMode && (
                <span className="mr-1 flex-shrink-0 flex items-center gap-1 rounded-full bg-[#1db954]/15 border border-[#1db954]/30 px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-[#1db954]">
                  <svg viewBox="0 0 16 16" width="8" height="8" fill="currentColor">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                  </svg>
                  {guestDjEnabled ? "DJ" : "Radio"}
                </span>
              )}

              {/* Guest DJ toggle — AI smart-shuffle for radio mode */}
              <button
                onClick={toggleGuestDj}
                title={guestDjEnabled ? "Guest DJ: On — click to disable" : "Guest DJ: Off — click for AI-curated radio"}
                className={`flex-shrink-0 flex h-8 w-8 items-center justify-center transition-colors ${guestDjEnabled ? "text-[#1db954]" : "text-white/40 hover:text-white/70"}`}
                aria-label="Toggle Guest DJ"
              >
                {/* Headphones icon */}
                <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor">
                  <path d="M8 1a6 6 0 0 0-6 6v2.5a2.5 2.5 0 0 0 2.5 2.5H5a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1H3.05A5 5 0 0 1 13 7H11a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h.5A2.5 2.5 0 0 0 14 9.5V7a6 6 0 0 0-6-6z" />
                </svg>
              </button>

              {/* Queue toggle */}
              <button
                onClick={() => setQueueOpen(!isQueueOpen)}
                className={`flex-shrink-0 mr-1 flex h-8 w-8 items-center justify-center transition-colors ${isQueueOpen ? "text-[#1db954]" : "text-white/70 hover:text-white"}`}
                aria-label="Queue"
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <path d="M15 15H1v-1.5h14V15zm0-4.5H1V9h14v1.5zm-14-7A2.5 2.5 0 0 1 3.5 1h9a2.5 2.5 0 0 1 0 5h-9A2.5 2.5 0 0 1 1 3.5zm2.5-1a1 1 0 0 0 0 2h9a1 1 0 0 0 0-2h-9z" />
                </svg>
              </button>

              {/* Volume icon — muted / low / full */}
              <button onClick={() => setVolume(volume === 0 ? 80 : 0)} className="flex-shrink-0 text-white/70 hover:text-white transition-colors">
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
              <div className="w-[5.813rem]">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={volume}
                  onChange={e => setVolume(parseInt(e.target.value, 10))}
                  className="h-1 w-full cursor-pointer appearance-none rounded-full"
                  style={{
                    background: `linear-gradient(to right, white 0%, white ${volume}%, #535353 ${volume}%, #535353 100%)`,
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
