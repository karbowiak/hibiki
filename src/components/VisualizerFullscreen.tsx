import { useEffect, useRef, useState, useCallback } from "react"
import { useVisualizerStore, type FullscreenVisualizerMode } from "../stores/visualizerStore"
import { usePlayerStore } from "../stores/playerStore"
import { useShallow } from "zustand/react/shallow"
import { initPresetMeta, loadAllPacks, getPreset, getAllNames } from "../lib/milkdropPresets"
import { formatMs } from "../lib/formatters"
import VisualizerCanvas from "./VisualizerCanvas"
import MilkdropPresetBrowser from "./MilkdropPresetBrowser"

// Logarithmic DFT — same algorithm as VisualizerCanvas for consistency
function computeSpectrum(samples: Float32Array, bins: number): Float32Array {
  const N = Math.min(samples.length, 1024)
  const result = new Float32Array(bins)
  const fMin = 1
  const fMax = N / 2
  for (let b = 0; b < bins; b++) {
    const f = Math.max(1, Math.round(fMin * Math.pow(fMax / fMin, b / (bins - 1))))
    let real = 0, imag = 0
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * f * n) / N
      real += samples[n] * Math.cos(angle)
      imag -= samples[n] * Math.sin(angle)
    }
    // Heavy compression (^0.15) so the 50× bass/treble energy gap is reduced.
    result[b] = Math.pow(Math.sqrt(real * real + imag * imag) / N, 0.15)
  }
  // Cubic attenuation: bass ×0.4, mids ×0.45, highs ×0.8.
  for (let b = 0; b < bins; b++) {
    const t = b / (bins - 1)
    result[b] *= (0.4 + 0.4 * t * t * t) * 0.9
  }
  return result
}

export default function VisualizerFullscreen() {
  const {
    closeFullscreen,
    fullscreenMode,
    setFullscreenMode,
    getRecentSamples,
    currentPresetName,
    setCurrentPreset,
    presetBrowserOpen,
    setPresetBrowserOpen,
    autoCycleEnabled,
    autoCycleIntervalSec,
    autoCycleMode,
    toggleFavorite,
    isFavorite,
    getRandomPresetName,
    getNextPresetName,
    starfieldReactivity,
    starfieldBaseSpeed,
    setStarfieldReactivity,
    setStarfieldBaseSpeed,
  } = useVisualizerStore(
    useShallow((s) => ({
      closeFullscreen: s.closeFullscreen,
      fullscreenMode: s.fullscreenMode,
      setFullscreenMode: s.setFullscreenMode,
      getRecentSamples: s.getRecentSamples,
      currentPresetName: s.currentPresetName,
      setCurrentPreset: s.setCurrentPreset,
      presetBrowserOpen: s.presetBrowserOpen,
      setPresetBrowserOpen: s.setPresetBrowserOpen,
      autoCycleEnabled: s.autoCycleEnabled,
      autoCycleIntervalSec: s.autoCycleIntervalSec,
      autoCycleMode: s.autoCycleMode,
      toggleFavorite: s.toggleFavorite,
      isFavorite: s.isFavorite,
      getRandomPresetName: s.getRandomPresetName,
      getNextPresetName: s.getNextPresetName,
      starfieldReactivity: s.starfieldReactivity,
      starfieldBaseSpeed: s.starfieldBaseSpeed,
      setStarfieldReactivity: s.setStarfieldReactivity,
      setStarfieldBaseSpeed: s.setStarfieldBaseSpeed,
    })),
  )
  const { currentTrack, isPlaying, pause, resume, next, prev, seekTo, positionMs, waveformLevels } = usePlayerStore(
    useShallow((s) => ({
      currentTrack: s.currentTrack,
      isPlaying: s.isPlaying,
      pause: s.pause,
      resume: s.resume,
      next: s.next,
      prev: s.prev,
      seekTo: s.seekTo,
      positionMs: s.positionMs,
      waveformLevels: s.waveformLevels,
    })),
  )
  const [seekHoverPct, setSeekHoverPct] = useState<number | null>(null)
  // Separate canvases: 2D canvas for spectrum/oscilloscope/vu, WebGL canvas for milkdrop.
  // A canvas cannot share WebGL and 2D contexts — using one canvas causes getContext("2d")
  // to return null once butterchurn has claimed it with WebGL.
  const canvas2dRef = useRef<HTMLCanvasElement>(null)
  const canvasMilkdropRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)

  // Smoothing state for spectrum (exponential moving average per bin)
  const specSmoothedRef = useRef<Float32Array | null>(null)
  // Ballistic state for VU meter (fast attack / slow release)
  const vuSmoothedRef = useRef({ L: 0, R: 0 })

  // Starfield state — 800 stars with 3D coordinates, persisted across frames
  interface Star { x: number; y: number; z: number; pz: number }
  const starsRef = useRef<Star[] | null>(null)
  const starSpeedRef = useRef(0)

  // Butterchurn state
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vizRef = useRef<any>(null)

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore when typing in search input
      if (e.target instanceof HTMLInputElement) return

      switch (e.key) {
        case "Escape":
          if (presetBrowserOpen) {
            setPresetBrowserOpen(false)
          } else {
            closeFullscreen()
          }
          break
        case "ArrowLeft":
          if (fullscreenMode === "milkdrop") {
            const name = getNextPresetName(-1)
            if (name) setCurrentPreset(name)
          }
          break
        case "ArrowRight":
          if (fullscreenMode === "milkdrop") {
            const name = getNextPresetName(1)
            if (name) setCurrentPreset(name)
          }
          break
        case "r":
        case "R":
          if (fullscreenMode === "milkdrop") {
            const name = getRandomPresetName(currentPresetName ?? undefined)
            if (name) setCurrentPreset(name)
          }
          break
        case "f":
        case "F":
          if (fullscreenMode === "milkdrop" && currentPresetName) {
            toggleFavorite(currentPresetName)
          }
          break
        case "b":
        case "B":
          if (fullscreenMode === "milkdrop") {
            setPresetBrowserOpen(!presetBrowserOpen)
          }
          break
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [
    closeFullscreen, fullscreenMode, presetBrowserOpen, setPresetBrowserOpen,
    getNextPresetName, getRandomPresetName, setCurrentPreset, currentPresetName, toggleFavorite,
  ])

  // Resize the 2D canvas to match its display size whenever a 2D mode is active.
  useEffect(() => {
    if (fullscreenMode === "milkdrop") return
    const canvas = canvas2dRef.current
    if (!canvas) return
    const resize = () => {
      canvas.width = canvas.clientWidth || window.innerWidth
      canvas.height = canvas.clientHeight || window.innerHeight
    }
    resize()
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [fullscreenMode])

  // Setup/teardown butterchurn when entering milkdrop mode
  useEffect(() => {
    if (fullscreenMode !== "milkdrop") {
      if (processorRef.current) {
        processorRef.current.disconnect()
        processorRef.current = null
      }
      if (audioCtxRef.current) {
        void audioCtxRef.current.close()
        audioCtxRef.current = null
      }
      vizRef.current = null
      return
    }

    const canvas = canvasMilkdropRef.current
    if (!canvas) return

    let cancelled = false
    ;(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const butterchurn = ((await import("butterchurn")) as any).default
      const names = await initPresetMeta()
      if (cancelled) return

      const ctx = new AudioContext({ sampleRate: 44100, latencyHint: "interactive" })
      audioCtxRef.current = ctx

      const processor = ctx.createScriptProcessor(2048, 0, 2)
      processorRef.current = processor
      processor.onaudioprocess = (e) => {
        const pcm = getRecentSamples(2048)
        const L = e.outputBuffer.getChannelData(0)
        const R = e.outputBuffer.getChannelData(1)
        for (let i = 0; i < 2048; i++) {
          L[i] = pcm[Math.min(i, pcm.length - 1)]
          R[i] = pcm[Math.min(i, pcm.length - 1)]
        }
      }
      const mute = ctx.createGain()
      mute.gain.value = 0
      processor.connect(mute)
      mute.connect(ctx.destination)

      const W = canvas.clientWidth || 1280
      const H = canvas.clientHeight || 720
      canvas.width = W
      canvas.height = H

      const viz = butterchurn.createVisualizer(ctx, canvas, { width: W, height: H, textureRatio: 1 })
      viz.connectAudio(processor)
      vizRef.current = viz

      // Load all preset packs in background
      await loadAllPacks()
      if (cancelled) return

      // Apply saved preset or pick first one
      const savedName = useVisualizerStore.getState().currentPresetName
      const initialName = savedName && names.includes(savedName) ? savedName : names[0] ?? null
      if (initialName) {
        const preset = getPreset(initialName)
        if (preset) {
          viz.loadPreset(preset, 0)
          if (!savedName) setCurrentPreset(initialName)
        }
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreenMode])

  // Load new preset when currentPresetName changes (after init)
  useEffect(() => {
    if (!vizRef.current || !currentPresetName) return
    const preset = getPreset(currentPresetName)
    if (preset) {
      vizRef.current.loadPreset(preset, 2.0)
    }
  }, [currentPresetName])

  // Auto-cycle effect
  useEffect(() => {
    if (fullscreenMode !== "milkdrop" || !autoCycleEnabled) return

    const interval = setInterval(() => {
      const store = useVisualizerStore.getState()
      let name: string | null
      if (store.autoCycleMode === "random") {
        name = store.getRandomPresetName(store.currentPresetName ?? undefined)
      } else {
        name = store.getNextPresetName(1)
      }
      if (name) store.setCurrentPreset(name)
    }, autoCycleIntervalSec * 1000)

    return () => clearInterval(interval)
  }, [fullscreenMode, autoCycleEnabled, autoCycleIntervalSec, autoCycleMode])

  // Render loop
  const draw = useCallback(() => {
    if (fullscreenMode === "milkdrop") {
      if (vizRef.current) vizRef.current.render()
      return
    }

    const canvas = canvas2dRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const W = canvas.width
    const H = canvas.height
    // Starfield uses its own fade-to-black for motion trails — don't hard-clear it
    if (fullscreenMode !== "starfield") ctx.clearRect(0, 0, W, H)

    if (fullscreenMode === "spectrum") {
      const pcm = getRecentSamples(1024)
      const BINS = 128
      const raw = computeSpectrum(pcm, BINS)
      // Exponential moving average: fast attack (α=0.4), moderate release (α=0.18)
      if (!specSmoothedRef.current || specSmoothedRef.current.length !== BINS) {
        specSmoothedRef.current = new Float32Array(BINS)
      }
      const smoothed = specSmoothedRef.current
      for (let i = 0; i < BINS; i++) {
        const α = raw[i] > smoothed[i] ? 0.4 : 0.18
        smoothed[i] += α * (raw[i] - smoothed[i])
      }
      const barW = W / BINS
      const maxVal = Math.max(...Array.from(smoothed), 0.001)
      for (let i = 0; i < BINS; i++) {
        const x = i * barW
        const norm = smoothed[i] / maxVal
        const barH = Math.max(2, norm * H * 0.85)
        ctx.fillStyle = `hsl(${120 + norm * 60}, 80%, 50%)`
        ctx.fillRect(x + 1, H - barH, barW - 2, barH)
      }
    } else if (fullscreenMode === "oscilloscope") {
      const accent = getComputedStyle(canvas).getPropertyValue("--accent").trim() || "#d946ef"
      const pcm = getRecentSamples(1024)
      ctx.strokeStyle = accent
      ctx.lineWidth = 2
      ctx.shadowColor = accent
      ctx.shadowBlur = 8
      ctx.beginPath()
      const mid = H / 2
      for (let i = 0; i < pcm.length; i++) {
        const x = (i / (pcm.length - 1)) * W
        const y = mid - pcm[i] * mid * 1.5
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    } else if (fullscreenMode === "vu") {
      const pcm = getRecentSamples(512)
      let sumL = 0, sumR = 0, count = 0
      for (let i = 0; i < pcm.length - 1; i += 2) {
        sumL += pcm[i] * pcm[i]; sumR += pcm[i + 1] * pcm[i + 1]; count++
      }
      const rmsL = count > 0 ? Math.sqrt(sumL / count) : 0
      const rmsR = count > 0 ? Math.sqrt(sumR / count) : 0
      // Ballistic smoothing: fast attack, moderate release
      const vu = vuSmoothedRef.current
      vu.L += (rmsL > vu.L ? 0.55 : 0.15) * (rmsL - vu.L)
      vu.R += (rmsR > vu.R ? 0.55 : 0.15) * (rmsR - vu.R)
      // Range: -40 dBFS to 0 dBFS — spreads the musically relevant range across the bar
      const DB_FLOOR = -40
      const vuAccent = getComputedStyle(canvas).getPropertyValue("--accent").trim() || "#d946ef"
      const drawVU = (rms: number, y: number, h: number, label: string) => {
        const db = rms > 0 ? 20 * Math.log10(rms) : DB_FLOOR
        const fill = Math.max(0, Math.min(1, (db - DB_FLOOR) / (-DB_FLOOR))) * W
        const grad = ctx.createLinearGradient(0, 0, W, 0)
        grad.addColorStop(0, vuAccent); grad.addColorStop(0.7, vuAccent)
        grad.addColorStop(0.85, "#f0c040"); grad.addColorStop(1, "#e04040")
        ctx.fillStyle = "#222"; ctx.fillRect(0, y, W, h)
        ctx.fillStyle = grad; ctx.fillRect(0, y, fill, h)
        const fontSize = Math.min(h * 0.6, 20)
        ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.font = `${fontSize}px sans-serif`
        ctx.fillText(label, 12, y + h / 2 + fontSize * 0.35)
        const dbText = `${db.toFixed(1)} dB`
        const dbWidth = ctx.measureText(dbText).width
        ctx.fillText(dbText, W - dbWidth - 12, y + h / 2 + fontSize * 0.35)
      }
      const barH = H * 0.15; const pad = H * 0.3
      drawVU(vu.L, pad, barH, "L")
      drawVU(vu.R, pad + barH + 12, barH, "R")
    } else if (fullscreenMode === "starfield") {
      const NUM_STARS = 800
      const MAX_DEPTH = 1500

      // Initialize stars on first frame
      if (!starsRef.current || starsRef.current.length !== NUM_STARS) {
        starsRef.current = Array.from({ length: NUM_STARS }, () => {
          const x = (Math.random() - 0.5) * W * 2
          const y = (Math.random() - 0.5) * H * 2
          const z = Math.random() * MAX_DEPTH
          return { x, y, z, pz: z }
        })
      }

      // Read reactivity settings from store (direct getState to avoid re-render deps)
      const { starfieldReactivity, starfieldBaseSpeed } = useVisualizerStore.getState()
      const react01 = starfieldReactivity / 100 // 0 = chill, 1 = full warp

      // Audio reactivity: bass drives speed, overall RMS drives trail intensity
      const pcm = getRecentSamples(512)
      let sum = 0
      for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
      const rms = Math.sqrt(sum / pcm.length)

      // Compute bass energy (first 64 samples ~ low frequencies)
      let bassSum = 0
      const bassN = Math.min(64, pcm.length)
      for (let i = 0; i < bassN; i++) bassSum += Math.abs(pcm[i])
      const bassEnergy = bassSum / bassN

      // Speed: base cruise + audio boost scaled by reactivity
      const audioBoost = (bassEnergy * 60 + rms * 30) * react01
      const targetSpeed = starfieldBaseSpeed + audioBoost
      starSpeedRef.current += 0.15 * (targetSpeed - starSpeedRef.current)
      const speed = starSpeedRef.current

      // Trail length scales with speed
      const trailFactor = Math.min(speed / 4, 8)

      const cx = W / 2
      const cy = H / 2
      const fov = 256

      // Fade the previous frame — creates motion blur / trail effect
      ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0.15, 0.4 - rms * 0.5)})`
      ctx.fillRect(0, 0, W, H)

      const stars = starsRef.current
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i]
        s.pz = s.z
        s.z -= speed

        // Recycle stars that pass the viewer
        if (s.z <= 0) {
          s.x = (Math.random() - 0.5) * W * 2
          s.y = (Math.random() - 0.5) * H * 2
          s.z = MAX_DEPTH
          s.pz = MAX_DEPTH
          continue
        }

        // Project current position
        const sx = cx + (s.x / s.z) * fov
        const sy = cy + (s.y / s.z) * fov

        // Skip if off screen
        if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) continue

        // Project previous position for trail
        const px = cx + (s.x / s.pz) * fov
        const py = cy + (s.y / s.pz) * fov

        // Brightness based on depth (closer = brighter)
        const depthNorm = 1 - s.z / MAX_DEPTH
        const brightness = Math.min(1, depthNorm * depthNorm * 1.5)
        const size = Math.max(0.5, depthNorm * 3)

        // Draw trail line
        if (trailFactor > 0.5) {
          ctx.strokeStyle = `rgba(200, 210, 255, ${brightness * 0.6})`
          ctx.lineWidth = size * 0.6
          ctx.beginPath()
          ctx.moveTo(px, py)
          ctx.lineTo(sx, sy)
          ctx.stroke()
        }

        // Draw star dot
        ctx.fillStyle = `rgba(220, 230, 255, ${brightness})`
        ctx.beginPath()
        ctx.arc(sx, sy, size, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }, [fullscreenMode, getRecentSamples])

  useEffect(() => {
    let cancelled = false
    function loop() {
      if (cancelled) return
      draw()
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => { cancelled = true; cancelAnimationFrame(rafRef.current) }
  }, [draw])

  const MODES: FullscreenVisualizerMode[] = ["spectrum", "oscilloscope", "vu", "starfield", "milkdrop"]

  const thumbUrl = currentTrack?.thumbUrl ?? null
  const isMilkdrop = fullscreenMode === "milkdrop"
  const currentIsFav = currentPresetName ? isFavorite(currentPresetName) : false

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col hero-overlay">
      {/* Close button — top right corner */}
      <button
        onClick={closeFullscreen}
        className="absolute top-4 right-4 z-20 text-white/30 hover:text-white text-xl transition-colors"
        aria-label="Close visualizer"
      >
        ✕
      </button>

      {/* Canvas area — two canvases, only one visible at a time */}
      <div className="flex-1 relative">
        <canvas
          ref={canvas2dRef}
          className="absolute inset-0 w-full h-full"
          style={{ display: !isMilkdrop ? "block" : "none" }}
        />
        <canvas
          ref={canvasMilkdropRef}
          className="absolute inset-0 w-full h-full"
          style={{ display: isMilkdrop ? "block" : "none" }}
        />

        {/* Preset browser overlay */}
        {presetBrowserOpen && isMilkdrop && <MilkdropPresetBrowser />}
      </div>

      {/* Bottom bar — track info + playback + mode pills + preset controls */}
      <div className="flex items-center gap-4 px-5 py-3 bg-black/60 backdrop-blur-sm z-10">
        {/* Track info */}
        <div className="flex items-center gap-3 min-w-0 shrink-0">
          {thumbUrl && (
            <img src={thumbUrl} className="w-10 h-10 rounded object-cover" alt="" />
          )}
          <div className="min-w-0">
            <div className="text-white font-semibold text-sm truncate max-w-[180px]">
              {currentTrack?.title ?? "—"}
            </div>
            <div className="text-white/50 text-xs truncate max-w-[180px]">
              {currentTrack?.artistName}
            </div>
          </div>
        </div>

        {/* Playback controls */}
        <div className="flex items-center gap-3">
          <button onClick={() => prev()} className="text-white/70 hover:text-white transition-colors" aria-label="Previous">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
            </svg>
          </button>
          <button
            onClick={() => isPlaying ? pause() : resume()}
            className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <button onClick={() => next()} className="text-white/70 hover:text-white transition-colors" aria-label="Next">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zm2.5-6 8.5 6V6z" />
            </svg>
          </button>
        </div>

        {/* Seek bar with waveform */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-[0.625rem] text-white/50 tabular-nums shrink-0">
            {formatMs(seekHoverPct !== null ? (currentTrack?.duration ?? 0) * seekHoverPct / 100 : positionMs)}
          </span>
          <div
            className="relative flex-1 h-7 cursor-pointer select-none min-w-0"
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
              progressPct={currentTrack?.duration ? (positionMs / currentTrack.duration) * 100 : 0}
              hoverPct={seekHoverPct}
              levels={waveformLevels}
              mode="waveform"
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
          <span className="text-[0.625rem] text-white/50 tabular-nums shrink-0">
            {formatMs(currentTrack?.duration ?? 0)}
          </span>
        </div>

        {/* Visualizer-specific settings (between waveform and mode pills) */}
        {fullscreenMode === "starfield" && (
          <>
            <span className="text-white/10">|</span>
            <div className="flex items-center gap-4 text-white/60 text-xs">
              <label className="flex items-center gap-2">
                <span className="text-white/40 whitespace-nowrap">Reactivity</span>
                <input type="range" min={0} max={100} value={starfieldReactivity}
                  onChange={(e) => setStarfieldReactivity(Number(e.target.value))}
                  className="w-24 accent-[var(--accent)]" />
                <span className="text-white/30 w-8 text-right">{starfieldReactivity}%</span>
              </label>
              <label className="flex items-center gap-2">
                <span className="text-white/40 whitespace-nowrap">Speed</span>
                <input type="range" min={1} max={10} step={0.5} value={starfieldBaseSpeed}
                  onChange={(e) => setStarfieldBaseSpeed(Number(e.target.value))}
                  className="w-20 accent-[var(--accent)]" />
                <span className="text-white/30 w-4 text-right">{starfieldBaseSpeed}</span>
              </label>
            </div>
          </>
        )}

        {isMilkdrop && getAllNames().length > 0 && (
          <>
            <span className="text-white/10">|</span>
            <div className="flex items-center gap-2 text-white/60 text-sm">
              <button
                onClick={() => { const n = getNextPresetName(-1); if (n) setCurrentPreset(n) }}
                className="hover:text-white" aria-label="Previous preset"
              >
                <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                  <path d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" />
                </svg>
              </button>
              <button
                onClick={() => setPresetBrowserOpen(true)}
                className="max-w-[180px] truncate text-xs hover:text-white transition-colors"
                title={currentPresetName ?? ""}
              >
                {currentPresetName ?? "Loading…"}
              </button>
              <button
                onClick={() => { const n = getNextPresetName(1); if (n) setCurrentPreset(n) }}
                className="hover:text-white" aria-label="Next preset"
              >
                <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                  <path d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" />
                </svg>
              </button>
              <span className="text-white/20">|</span>
              <button
                onClick={() => { const n = getRandomPresetName(currentPresetName ?? undefined); if (n) setCurrentPreset(n) }}
                className="hover:text-white" aria-label="Random preset" title="Random (R)"
              >
                <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                  <path d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-1.06 1.06a7 7 0 0012.712-3.526h1.737l-2.5-3-2.5 3h1.812zm-10.624-2.848a5.5 5.5 0 019.201-2.466l1.06-1.06A7 7 0 002.237 8.576H.5l2.5 3 2.5-3H3.688z" />
                </svg>
              </button>
              <button
                onClick={() => currentPresetName && toggleFavorite(currentPresetName)}
                className={`transition-colors ${currentIsFav ? "text-red-400" : "hover:text-white"}`}
                aria-label={currentIsFav ? "Unfavorite" : "Favorite"} title="Favorite (F)"
              >
                {currentIsFav ? "♥" : "♡"}
              </button>
              <button
                onClick={() => useVisualizerStore.getState().setAutoCycleEnabled(!autoCycleEnabled)}
                className={`transition-colors ${autoCycleEnabled ? "text-[var(--accent)]" : "hover:text-white"}`}
                aria-label={autoCycleEnabled ? "Disable auto-cycle" : "Enable auto-cycle"}
                title={`Auto-cycle ${autoCycleEnabled ? "on" : "off"} (${autoCycleIntervalSec}s)`}
              >
                <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                  <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" />
                </svg>
              </button>
              <button
                onClick={() => setPresetBrowserOpen(!presetBrowserOpen)}
                className={`transition-colors ${presetBrowserOpen ? "text-[var(--accent)]" : "hover:text-white"}`}
                aria-label="Browse presets" title="Browse (B)"
              >
                <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                  <path d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
                </svg>
              </button>
            </div>
          </>
        )}

        {/* Separator */}
        <span className="text-white/10">|</span>

        {/* Mode pills — far right */}
        <div className="flex gap-1.5 shrink-0">
          {MODES.map(m => (
            <button
              key={m}
              onClick={() => setFullscreenMode(m)}
              className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${
                fullscreenMode === m
                  ? "bg-accent text-black font-semibold"
                  : "bg-white/10 text-white/70 hover:bg-white/20"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
