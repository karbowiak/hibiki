import { useEffect, useRef, useState, useCallback } from "react"
import { useVisualizerStore, type FullscreenVisualizerMode } from "../stores/visualizerStore"
import { usePlayerStore } from "../stores/playerStore"
import { useConnectionStore, buildPlexImageUrl } from "../stores"
import { useShallow } from "zustand/react/shallow"

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
  const { closeFullscreen, fullscreenMode, setFullscreenMode, getRecentSamples } = useVisualizerStore(
    useShallow(s => ({
      closeFullscreen: s.closeFullscreen,
      fullscreenMode: s.fullscreenMode,
      setFullscreenMode: s.setFullscreenMode,
      getRecentSamples: s.getRecentSamples,
    }))
  )
  const { currentTrack, isPlaying, pause, resume, next, prev } = usePlayerStore(
    useShallow(s => ({
      currentTrack: s.currentTrack,
      isPlaying: s.isPlaying,
      pause: s.pause,
      resume: s.resume,
      next: s.next,
      prev: s.prev,
    }))
  )
  const { baseUrl, token } = useConnectionStore(
    useShallow(s => ({ baseUrl: s.baseUrl, token: s.token }))
  )

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

  // Butterchurn state
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vizRef = useRef<any>(null)
  const [presetNames, setPresetNames] = useState<string[]>([])
  const [presetIdx, setPresetIdx] = useState(0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const presetsRef = useRef<Record<string, any>>({})

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeFullscreen()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [closeFullscreen])

  // Resize the 2D canvas to match its display size whenever a 2D mode is active.
  // Without this canvas.width/height default to 300×150 and CSS stretches the
  // tiny buffer to fullscreen — nothing visible at sensible line widths.
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allPresets = ((await import("butterchurn-presets")) as any).default
      if (cancelled) return

      presetsRef.current = allPresets
      const names = Object.keys(allPresets)
      setPresetNames(names)

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

      if (names.length > 0) {
        viz.loadPreset(allPresets[names[presetIdx]], 0)
      }
    })()

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreenMode])

  // Load new preset when presetIdx changes
  useEffect(() => {
    if (!vizRef.current || presetNames.length === 0) return
    vizRef.current.loadPreset(presetsRef.current[presetNames[presetIdx]], 2.0)
  }, [presetIdx, presetNames])

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
    ctx.clearRect(0, 0, W, H)

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

  const MODES: FullscreenVisualizerMode[] = ["spectrum", "oscilloscope", "vu", "milkdrop"]

  const thumbUrl = currentTrack?.thumb
    ? buildPlexImageUrl(baseUrl ?? "", token ?? "", currentTrack.thumb)
    : null

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col hero-overlay">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 bg-black/60 backdrop-blur-sm z-10">
        <div className="flex items-center gap-3">
          {thumbUrl && (
            <img
              src={thumbUrl}
              className="w-10 h-10 rounded object-cover"
              alt=""
            />
          )}
          <div className="min-w-0">
            <div className="text-white font-semibold text-sm truncate max-w-[200px]">
              {currentTrack?.title ?? "—"}
            </div>
            <div className="text-white/50 text-xs truncate max-w-[200px]">
              {currentTrack?.grandparent_title}
            </div>
          </div>
        </div>

        {/* Playback controls */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => prev()}
            className="text-white/70 hover:text-white transition-colors"
            aria-label="Previous"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
            </svg>
          </button>
          <button
            onClick={() => isPlaying ? pause() : resume()}
            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <button
            onClick={() => next()}
            className="text-white/70 hover:text-white transition-colors"
            aria-label="Next"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zm2.5-6 8.5 6V6z" />
            </svg>
          </button>
        </div>

        <button
          onClick={closeFullscreen}
          className="text-white/50 hover:text-white text-xl ml-4"
          aria-label="Close visualizer"
        >
          ✕
        </button>
      </div>

      {/* Canvas area — two canvases, only one visible at a time */}
      <div className="flex-1 relative">
        <canvas
          ref={canvas2dRef}
          className="absolute inset-0 w-full h-full"
          style={{ display: fullscreenMode !== "milkdrop" ? "block" : "none" }}
        />
        <canvas
          ref={canvasMilkdropRef}
          className="absolute inset-0 w-full h-full"
          style={{ display: fullscreenMode === "milkdrop" ? "block" : "none" }}
        />
      </div>

      {/* Bottom bar — mode selector + preset picker */}
      <div className="flex items-center justify-between px-6 py-3 bg-black/60 backdrop-blur-sm z-10">
        <div className="flex gap-2">
          {MODES.map(m => (
            <button
              key={m}
              onClick={() => setFullscreenMode(m)}
              className={`rounded-full px-4 py-1.5 text-sm capitalize transition-colors ${
                fullscreenMode === m
                  ? "bg-accent text-black font-semibold"
                  : "bg-white/10 text-white/70 hover:bg-white/20"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {fullscreenMode === "milkdrop" && presetNames.length > 0 && (
          <div className="flex items-center gap-2 text-white/60 text-sm">
            <button
              onClick={() => setPresetIdx(i => (i - 1 + presetNames.length) % presetNames.length)}
              className="hover:text-white"
            >
              ‹
            </button>
            <span className="max-w-[240px] truncate text-xs">{presetNames[presetIdx]}</span>
            <button
              onClick={() => setPresetIdx(i => (i + 1) % presetNames.length)}
              className="hover:text-white"
            >
              ›
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
