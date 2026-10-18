import { Button } from "./shared/Button"
import { ArtworkImage } from "./shared/ArtworkImage"
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react"
import { createPortal } from "react-dom"
import { IconX } from "@tabler/icons-react"
import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { usePlaybackPalette } from "../lib/playbackPaletteContext"
import { useVisualizerStore, type FullscreenVisualizerMode } from "../stores/visualizerStore"
import { usePlayerStore } from "../stores/playerStore"
import { useShallow } from "zustand/react/shallow"
import { initPresetMeta, loadAllPacks, getPreset, getAllNames } from "../lib/milkdropPresets"
import { formatMs } from "../lib/formatters"
import { useReducedMotion } from "../hooks/useReducedMotion"
import { useVisualizerHotkeys } from "../hooks/useVisualizerHotkeys"
import VisualizerCanvas from "./VisualizerCanvas"
import MilkdropPresetBrowser from "./MilkdropPresetBrowser"
import { computeSpectrumFromFFT } from "../lib/visualizerSpectrum"
import { useVisualizationVisibility } from "../hooks/useVisualizationVisibility"
import { useVisualizationFrames } from "../hooks/useVisualizationFrames"

// Starfield hue palette for colored stars
const STAR_HUES = [5, 15, 40, 50, 175, 190, 215, 225, 310, 330]
function randomStarHue(): number {
  return STAR_HUES[Math.floor(Math.random() * STAR_HUES.length)]
}

export default function VisualizerFullscreen() {
  const palette = usePlaybackPalette()
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
    getFrequencyData,
    getSampleRate,
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
      getFrequencyData: s.getFrequencyData,
      getSampleRate: s.getSampleRate,
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
  const timeColumnWidth = `${Math.max(5, formatMs(currentTrack?.duration ?? 0).length)}ch`
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false)
  const [fullscreenError, setFullscreenError] = useState<string | null>(null)
  const restoreFullscreenRef = useRef<(() => void) | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const container = containerRef.current!
    const previousFocus = document.activeElement as HTMLElement | null
    const background = [...document.body.children]
      .filter(element => element !== container)
      .map(element => ({ element, inert: element.getAttribute("inert") }))
    background.forEach(({ element }) => element.setAttribute("inert", ""))
    container.focus({ preventScroll: true })
    return () => {
      restoreFullscreenRef.current?.()
      if (document.fullscreenElement === container) void document.exitFullscreen().catch(() => {})
      background.forEach(({ element, inert }) => {
        if (inert === null) element.removeAttribute("inert")
        else element.setAttribute("inert", inert)
      })
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [])

  // Separate canvases: 2D canvas for spectrum/oscilloscope/vu, WebGL canvas for milkdrop.
  // A canvas cannot share WebGL and 2D contexts — using one canvas causes getContext("2d")
  // to return null once butterchurn has claimed it with WebGL.
  const canvas2dRef = useRef<HTMLCanvasElement>(null)
  const canvasMilkdropRef = useRef<HTMLCanvasElement>(null)
  const visible = useVisualizationVisibility()
  const reducedMotion = useReducedMotion()
  const active = visible && isPlaying
  const activityRef = useRef(active)
  activityRef.current = active
  const [milkdropReady, setMilkdropReady] = useState(0)

  // Smoothing state for spectrum (exponential moving average per bin)
  const specSmoothedRef = useRef<Float32Array | null>(null)
  // Ballistic state for VU meter (fast attack / slow release)
  const vuSmoothedRef = useRef({ L: 0, R: 0 })

  // Starfield state — 800 moving + 300 static background stars
  interface Star { x: number; y: number; z: number; pz: number; hue: number | null }
  interface StaticStar { x: number; y: number; size: number; brightness: number; hue: number | null }
  const starsRef = useRef<Star[] | null>(null)
  const staticStarsRef = useRef<StaticStar[] | null>(null)
  const starSpeedRef = useRef(0)
  // Beat detection state for starfield
  const bassAvgRef = useRef(0)
  const beatDecayRef = useRef(0)

  // Cached accent colour — avoid getComputedStyle every frame (expensive when CSS vars are dirty)
  const cachedAccentRef = useRef("#d946ef")
  const accentTickRef = useRef(0)

  // Butterchurn state
  const audioCtxRef = useRef<AudioContext | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vizRef = useRef<any>(null)

  // Desktop WebKit does not consistently expose the browser Fullscreen API.
  // Use the actual Tauri window in the app and the document API in a browser.
  useEffect(() => {
    if (isTauri()) {
      const win = getCurrentWindow()
      let active = true
      let revision = 0
      const update = () => {
        const request = ++revision
        void win.isFullscreen().then(value => {
          if (active && revision === request) setIsNativeFullscreen(value)
        }).catch(() => {})
      }
      update()
      const listener = win.onResized(update)
      return () => {
        active = false
        void listener.then(unlisten => unlisten()).catch(() => {})
      }
    }
    const onFsChange = () => setIsNativeFullscreen(!!document.fullscreenElement)
    document.addEventListener("fullscreenchange", onFsChange)
    return () => document.removeEventListener("fullscreenchange", onFsChange)
  }, [])

  const toggleNativeFullscreen = useCallback(async () => {
    setFullscreenError(null)
    try {
      if (isTauri()) {
        const win = getCurrentWindow()
        const fullscreen = await win.isFullscreen()
        await win.setFullscreen(!fullscreen)
        if (!containerRef.current && !fullscreen) {
          await win.setFullscreen(false)
          return
        }
        restoreFullscreenRef.current = fullscreen ? null : () => { void win.setFullscreen(false).catch(() => {}) }
        setIsNativeFullscreen(!fullscreen)
      } else if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await containerRef.current?.requestFullscreen()
      }
    } catch {
      setFullscreenError("Couldn't change fullscreen mode. Try again.")
    }
  }, [])

  useVisualizerHotkeys(toggleNativeFullscreen)

  // Resize the 2D canvas to match its display size (DPR-aware for HiDPI).
  useEffect(() => {
    if (fullscreenMode === "milkdrop") return
    const canvas = canvas2dRef.current
    if (!canvas) return
    const resize = () => {
      const { renderScale } = useVisualizerStore.getState()
      const dpr = window.devicePixelRatio * renderScale
      const w = canvas.clientWidth || window.innerWidth
      const h = canvas.clientHeight || window.innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    resize()
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null
    observer?.observe(canvas)
    window.addEventListener("resize", resize)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", resize)
    }
  }, [fullscreenMode])

  // Setup/teardown butterchurn when entering milkdrop mode
  useEffect(() => {
    if (fullscreenMode !== "milkdrop") return

    const canvas = canvasMilkdropRef.current
    if (!canvas) return

    let cancelled = false
    let disposed = false
    let context: AudioContext | null = null
    let processor: ScriptProcessorNode | null = null
    let mute: GainNode | null = null
    let resizeObserver: ResizeObserver | null = null
    let visualizer: any = null
    const dispose = () => {
      if (disposed) return
      disposed = true
      resizeObserver?.disconnect()
      if (processor) {
        processor.onaudioprocess = null
        processor.disconnect()
      }
      mute?.disconnect()
      if (context) void context.close().catch(() => {})
      if (audioCtxRef.current === context) audioCtxRef.current = null
      if (vizRef.current === visualizer) vizRef.current = null
    }
    ;(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import("butterchurn")) as any
      // Vite 8 preserves the UMD bundle's nested CommonJS default export.
      const butterchurn = mod.default?.default ?? mod.default
      const names = await initPresetMeta()
      if (cancelled) return

      const ctx = new AudioContext({ sampleRate: 44100, latencyHint: "interactive" })
      context = ctx
      audioCtxRef.current = ctx
      void (activityRef.current ? ctx.resume() : ctx.suspend()).catch(() => {})

      processor = ctx.createScriptProcessor(2048, 0, 2)
      processor.onaudioprocess = (e) => {
        if (cancelled || !activityRef.current) return
        const pcm = getRecentSamples(2048)
        const L = e.outputBuffer.getChannelData(0)
        const R = e.outputBuffer.getChannelData(1)
        for (let i = 0; i < 2048; i++) {
          L[i] = pcm[Math.min(i, pcm.length - 1)]
          R[i] = pcm[Math.min(i, pcm.length - 1)]
        }
      }
      mute = ctx.createGain()
      mute.gain.value = 0
      processor.connect(mute)
      mute.connect(ctx.destination)

      const W = canvas.clientWidth || 1280
      const H = canvas.clientHeight || 720
      canvas.width = W
      canvas.height = H

      const viz = butterchurn.createVisualizer(ctx, canvas, { width: W, height: H, textureRatio: 1 })
      viz.connectAudio(processor)
      visualizer = viz
      vizRef.current = viz
      const resize = () => {
        const width = Math.max(1, canvas.clientWidth)
        const height = Math.max(1, canvas.clientHeight)
        viz.setRendererSize(width, height)
      }
      resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null
      resizeObserver?.observe(canvas)
      setMilkdropReady(value => value + 1)

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
    })().catch(() => {
      dispose()
    })

    return () => {
      cancelled = true
      dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreenMode])

  useEffect(() => {
    const context = audioCtxRef.current
    if (context) void (active ? context.resume() : context.suspend()).catch(() => {})
  }, [active, milkdropReady])

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
    if (fullscreenMode !== "milkdrop" || !autoCycleEnabled || !active) return

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
  }, [fullscreenMode, autoCycleEnabled, autoCycleIntervalSec, autoCycleMode, active])

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

    // Reduced motion: show a static placeholder instead of animating
    if (reducedMotion && fullscreenMode === "starfield") {
      ctx.fillStyle = "#000"
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = "rgba(255,255,255,0.3)"
      ctx.font = "16px sans-serif"
      ctx.textAlign = "center"
      ctx.fillText("Reduced motion enabled", W / 2, H / 2)
      return
    }

    // Starfield uses its own fade-to-black for motion trails — don't hard-clear it
    if (fullscreenMode !== "starfield") ctx.clearRect(0, 0, W, H)

    // Read viz colors from store (direct getState — no re-render deps needed)
    const { vizColorLow, vizColorMid, vizColorHigh } = useVisualizerStore.getState()

    // Refresh cached accent every ~30 frames (~500ms at 60fps) instead of
    // calling getComputedStyle every frame (expensive when rainbow dirties CSS vars)
    if (++accentTickRef.current >= 30) {
      accentTickRef.current = 0
      cachedAccentRef.current = getComputedStyle(canvas).getPropertyValue("--accent").trim() || "#d946ef"
    }

    if (fullscreenMode === "spectrum") {
      const BINS = 128
      // Native FFT bins already describe the actual output sample rate.
      const fftData = isPlaying ? getFrequencyData() : null
      const raw = fftData
        ? computeSpectrumFromFFT(fftData, BINS, getSampleRate())
        : new Float32Array(BINS)

      // Exponential moving average: fast attack (α=0.6), moderate release (α=0.25)
      if (!specSmoothedRef.current || specSmoothedRef.current.length !== BINS) {
        specSmoothedRef.current = new Float32Array(BINS)
      }
      const smoothed = specSmoothedRef.current
      for (let i = 0; i < BINS; i++) {
        const a = raw[i] > smoothed[i] ? 0.6 : 0.25
        smoothed[i] += a * (raw[i] - smoothed[i])
      }
      const barW = W / BINS

      // Vertical gradient per bar: green (bottom) → yellow (mid) → red (top)
      for (let i = 0; i < BINS; i++) {
        const x = i * barW
        const barH = Math.max(2, smoothed[i] * H * 0.85)
        const grad = ctx.createLinearGradient(x, H, x, H - barH)
        grad.addColorStop(0, vizColorLow)
        grad.addColorStop(0.5, vizColorMid)
        grad.addColorStop(1, vizColorHigh)
        ctx.fillStyle = grad
        ctx.fillRect(x + 1, H - barH, barW - 2, barH)
      }
    } else if (fullscreenMode === "oscilloscope") {
      const pcm = isPlaying ? getRecentSamples(1024) : new Float32Array(1024)
      const mid = H / 2

      // Build the full path once
      ctx.beginPath()
      for (let i = 0; i < pcm.length; i++) {
        const x = (i / (pcm.length - 1)) * W
        const y = mid - pcm[i] * mid * 1.5
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }

      // Horizontal gradient: low → mid → high (approximates per-segment displacement coloring)
      const grad = ctx.createLinearGradient(0, mid * 0.3, 0, mid * 1.7)
      grad.addColorStop(0, vizColorHigh)
      grad.addColorStop(0.35, vizColorMid)
      grad.addColorStop(0.5, vizColorLow)
      grad.addColorStop(0.65, vizColorMid)
      grad.addColorStop(1, vizColorHigh)

      ctx.lineWidth = 2
      ctx.strokeStyle = grad
      ctx.shadowBlur = 6
      ctx.shadowColor = vizColorMid
      ctx.stroke()
      ctx.shadowBlur = 0
    } else if (fullscreenMode === "vu") {
      const pcm = isPlaying ? getRecentSamples(512) : new Float32Array(512)
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
      // Range: -40 dBFS to 0 dBFS
      const DB_FLOOR = -40
      const drawVU = (rms: number, y: number, h: number, label: string) => {
        const db = rms > 0 ? 20 * Math.log10(rms) : DB_FLOOR
        const fill = Math.max(0, Math.min(1, (db - DB_FLOOR) / (-DB_FLOOR))) * W
        // Horizontal gradient: low→low→mid→high (hibiki style)
        const grad = ctx.createLinearGradient(0, 0, W, 0)
        grad.addColorStop(0, vizColorLow)
        grad.addColorStop(0.5, vizColorLow)
        grad.addColorStop(0.75, vizColorMid)
        grad.addColorStop(1, vizColorHigh)
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
      const NUM_STATIC = 300
      const MAX_DEPTH = 1500

      // Initialize moving stars
      if (!starsRef.current || starsRef.current.length !== NUM_STARS) {
        starsRef.current = Array.from({ length: NUM_STARS }, () => {
          const x = (Math.random() - 0.5) * W * 2
          const y = (Math.random() - 0.5) * H * 2
          const z = Math.random() * MAX_DEPTH
          // 20% of stars get a colored hue, rest are white/blue (null)
          const hue = Math.random() < 0.2 ? randomStarHue() : null
          return { x, y, z, pz: z, hue }
        })
      }

      // Initialize static background stars (subtle, muted)
      if (!staticStarsRef.current || staticStarsRef.current.length !== NUM_STATIC) {
        staticStarsRef.current = Array.from({ length: NUM_STATIC }, () => ({
          x: Math.random() * W,
          y: Math.random() * H,
          size: Math.random() * 1.0 + 0.3,
          brightness: Math.random() * 0.15 + 0.03,
          hue: Math.random() < 0.15 ? randomStarHue() : null,
        }))
      }

      // Read reactivity settings from store (direct getState to avoid re-render deps)
      const { starfieldReactivity, starfieldBaseSpeed } = useVisualizerStore.getState()
      const react01 = starfieldReactivity / 100

      // Audio reactivity
      const pcm = isPlaying ? getRecentSamples(512) : new Float32Array(512)
      let sum = 0
      for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
      const rms = Math.sqrt(sum / pcm.length)

      // Compute bass energy
      let bassSum = 0
      const bassN = Math.min(64, pcm.length)
      for (let i = 0; i < bassN; i++) bassSum += Math.abs(pcm[i])
      const bassEnergy = bassSum / bassN

      // Beat detection: compare bass against running average
      const BEAT_THRESHOLD = 0.15
      bassAvgRef.current += 0.05 * (bassEnergy - bassAvgRef.current)
      const isBeat = bassEnergy > bassAvgRef.current + BEAT_THRESHOLD
      if (isBeat) beatDecayRef.current = 1.0
      else beatDecayRef.current *= 0.92

      // Speed: base cruise + beat-driven burst + continuous audio
      const beatBoost = beatDecayRef.current * 40 * react01
      const continuousBoost = (bassEnergy * 30 + rms * 15) * react01
      const targetSpeed = starfieldBaseSpeed + beatBoost + continuousBoost
      starSpeedRef.current += 0.15 * (targetSpeed - starSpeedRef.current)
      const speed = starSpeedRef.current

      const trailFactor = Math.min(speed / 4, 8)
      const cx = W / 2
      const cy = H / 2
      const fov = 256

      // Fade the previous frame — motion blur / trail
      ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0.15, 0.4 - rms * 0.5)})`
      ctx.fillRect(0, 0, W, H)

      // Draw static background stars (fixed, non-moving)
      const staticStars = staticStarsRef.current!
      for (let i = 0; i < staticStars.length; i++) {
        const ss = staticStars[i]
        if (ss.hue !== null) {
          ctx.fillStyle = `hsla(${ss.hue}, 70%, 75%, ${ss.brightness})`
        } else {
          ctx.fillStyle = `rgba(200, 210, 255, ${ss.brightness})`
        }
        ctx.beginPath()
        ctx.arc(ss.x, ss.y, ss.size, 0, Math.PI * 2)
        ctx.fill()
      }

      // Draw moving stars
      const stars = starsRef.current!
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i]
        s.pz = s.z
        s.z -= speed

        if (s.z <= 0) {
          s.x = (Math.random() - 0.5) * W * 2
          s.y = (Math.random() - 0.5) * H * 2
          s.z = MAX_DEPTH
          s.pz = MAX_DEPTH
          s.hue = Math.random() < 0.2 ? randomStarHue() : null
          continue
        }

        const sx = cx + (s.x / s.z) * fov
        const sy = cy + (s.y / s.z) * fov
        if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) continue

        const px = cx + (s.x / s.pz) * fov
        const py = cy + (s.y / s.pz) * fov

        const depthNorm = 1 - s.z / MAX_DEPTH
        const brightness = Math.min(1, depthNorm * depthNorm * 1.5)
        const size = Math.max(0.5, depthNorm * 3)

        // Color: hued or white/blue
        const starColor = s.hue !== null
          ? `hsla(${s.hue}, 70%, 75%, ${brightness})`
          : `rgba(220, 230, 255, ${brightness})`
        const trailColor = s.hue !== null
          ? `hsla(${s.hue}, 60%, 65%, ${brightness * 0.6})`
          : `rgba(200, 210, 255, ${brightness * 0.6})`

        if (trailFactor > 0.5) {
          ctx.strokeStyle = trailColor
          ctx.lineWidth = size * 0.6
          ctx.beginPath()
          ctx.moveTo(px, py)
          ctx.lineTo(sx, sy)
          ctx.stroke()
        }

        ctx.fillStyle = starColor
        ctx.beginPath()
        ctx.arc(sx, sy, size, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }, [fullscreenMode, getRecentSamples, getFrequencyData, getSampleRate, isPlaying, milkdropReady, reducedMotion])

  useVisualizationFrames(draw, active && !(fullscreenMode === "starfield" && reducedMotion), visible)

  const MODES: FullscreenVisualizerMode[] = ["spectrum", "oscilloscope", "vu", "starfield", "milkdrop"]

  const thumbUrl = currentTrack?.thumbUrl ?? null
  const isMilkdrop = fullscreenMode === "milkdrop"
  const currentIsFav = currentPresetName ? isFavorite(currentPresetName) : false

  // A filtered playbar establishes a containing block for fixed descendants.
  // Render at the document level and carry the playing album's palette across.
  return createPortal(
    <div ref={containerRef} role="dialog" aria-modal="true" aria-label="Music visualization"
      tabIndex={-1} style={palette} className="fullscreen-visualizer hero-overlay"
      onKeyDown={event => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault()
          event.stopPropagation()
          if (presetBrowserOpen) setPresetBrowserOpen(false)
          else closeFullscreen()
          return
        }
        if (event.key !== "Tab") return
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')]
          .filter(element => element.getClientRects().length > 0)
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus()
        }
      }}>
      {/* Drag region — invisible strip at the top so the window can be moved */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-10 z-10" />

      {/* Close button — top right corner */}
      <Button
        variant="bare"
        onClick={closeFullscreen}
        className="fullscreen-visualizer-close absolute top-4 right-4 z-20"
        aria-label="Close visualizer"
      >
        <IconX size={20} aria-hidden="true" />
      </Button>

      {/* Canvas area — two canvases, only one visible at a time */}
      <div className="fullscreen-visualizer-stage relative min-h-0 flex-1">
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
      <div className="fullscreen-visualizer-controls relative z-10">
        <div className="fullscreen-visualizer-transport">
        {/* Track info — fixed width so layout doesn't shift */}
        <div className="fullscreen-visualizer-track flex min-w-0 items-center gap-3">
          {thumbUrl && (
            <ArtworkImage loading="eager" src={thumbUrl} className="w-10 h-10 rounded object-cover shrink-0" alt="" />
          )}
          <div className="min-w-0">
            <div className="text-white font-semibold text-sm truncate">
              {currentTrack?.title ?? "—"}
            </div>
            <div className="text-white/50 text-xs truncate">
              {currentTrack?.artistName}
            </div>
          </div>
        </div>

        {/* Playback controls */}
        <div className="flex items-center gap-3">
          <Button variant="bare" onClick={() => prev()} className="text-white/70 hover:text-white transition-colors" aria-label="Previous">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
            </svg>
          </Button>
          <Button
            variant="bare"
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
          </Button>
          <Button variant="bare" onClick={() => next()} className="text-white/70 hover:text-white transition-colors" aria-label="Next">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zm2.5-6 8.5 6V6z" />
            </svg>
          </Button>
        </div>

        {/* Seek bar with waveform */}
        <div className="fullscreen-visualizer-seek flex items-center gap-2 flex-1 min-w-0">
          <span className="text-[0.625rem] text-white/50 tabular-nums shrink-0 whitespace-nowrap text-right" style={{ width: timeColumnWidth }}>
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
          <span className="text-[0.625rem] text-white/50 tabular-nums shrink-0 whitespace-nowrap" style={{ width: timeColumnWidth }}>
            {formatMs(currentTrack?.duration ?? 0)}
          </span>
        </div>

        {/* Native fullscreen toggle stays next to the transport at every width. */}
        <Button
          variant="bare"
          onClick={toggleNativeFullscreen}
          className="fullscreen-visualizer-expand text-white/70 hover:text-white transition-colors"
          aria-label={isNativeFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          title="Fullscreen"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
            {isNativeFullscreen ? <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
              : <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />}
          </svg>
        </Button>
        </div>
        <div className="fullscreen-visualizer-options">
        <div className="fullscreen-visualizer-settings">
        {/* Visualizer-specific settings */}
        {fullscreenMode === "starfield" && (
          <>
            <div className="flex flex-wrap items-center gap-4 text-white/70 text-xs">
              <label className="flex items-center gap-2">
                <span className="text-white/70 whitespace-nowrap">Reactivity</span>
                <input type="range" min={0} max={100} value={starfieldReactivity}
                  onChange={(e) => setStarfieldReactivity(Number(e.target.value))}
                  className="w-24 accent-(--accent)" />
                <span className="text-white/60 w-8 text-right">{starfieldReactivity}%</span>
              </label>
              <label className="flex items-center gap-2">
                <span className="text-white/70 whitespace-nowrap">Speed</span>
                <input type="range" min={1} max={10} step={0.5} value={starfieldBaseSpeed}
                  onChange={(e) => setStarfieldBaseSpeed(Number(e.target.value))}
                  className="w-20 accent-(--accent)" />
                <span className="text-white/60 w-4 text-right">{starfieldBaseSpeed}</span>
              </label>
            </div>
          </>
        )}

        {isMilkdrop && getAllNames().length > 0 && (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-white/70 text-sm">
              <Button
                variant="bare"
                onClick={() => { const n = getNextPresetName(-1); if (n) setCurrentPreset(n) }}
                className="hover:text-white" aria-label="Previous preset"
              >
                <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                  <path d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" />
                </svg>
              </Button>
              <Button
                variant="bare"
                onClick={() => setPresetBrowserOpen(true)}
                className="max-w-[180px] truncate text-xs hover:text-white transition-colors"
                title={currentPresetName ?? ""}
              >
                {currentPresetName ?? "Loading…"}
              </Button>
              <Button
                variant="bare"
                onClick={() => { const n = getNextPresetName(1); if (n) setCurrentPreset(n) }}
                className="hover:text-white" aria-label="Next preset"
              >
                <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                  <path d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" />
                </svg>
              </Button>
              <span className="text-white/20">|</span>
              <Button
                variant="bare"
                onClick={() => { const n = getRandomPresetName(currentPresetName ?? undefined); if (n) setCurrentPreset(n) }}
                className="hover:text-white" aria-label="Random preset" title="Random (R)"
              >
                <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                  <path d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-1.06 1.06a7 7 0 0012.712-3.526h1.737l-2.5-3-2.5 3h1.812zm-10.624-2.848a5.5 5.5 0 019.201-2.466l1.06-1.06A7 7 0 002.237 8.576H.5l2.5 3 2.5-3H3.688z" />
                </svg>
              </Button>
              <Button
                variant="bare"
                onClick={() => currentPresetName && toggleFavorite(currentPresetName)}
                className={`transition-colors ${currentIsFav ? "text-red-400" : "hover:text-white"}`}
                aria-label={currentIsFav ? "Unfavorite" : "Favorite"} title="Favorite (F)"
              >
                {currentIsFav ? "♥" : "♡"}
              </Button>
              <Button
                variant="bare"
                onClick={() => useVisualizerStore.getState().setAutoCycleEnabled(!autoCycleEnabled)}
                className={`transition-colors ${autoCycleEnabled ? "text-(--accent)" : "hover:text-white"}`}
                aria-label={autoCycleEnabled ? "Disable auto-cycle" : "Enable auto-cycle"}
                title={`Auto-cycle ${autoCycleEnabled ? "on" : "off"} (${autoCycleIntervalSec}s)`}
              >
                <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                  <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" />
                </svg>
              </Button>
              <Button
                variant="bare"
                onClick={() => setPresetBrowserOpen(!presetBrowserOpen)}
                className={`transition-colors ${presetBrowserOpen ? "text-(--accent)" : "hover:text-white"}`}
                aria-label="Browse presets" title="Browse (B)"
              >
                <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                  <path d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
                </svg>
              </Button>
            </div>
          </>
        )}

        </div>

        {/* Mode pills — far right */}
        <div className="fullscreen-visualizer-modes flex flex-wrap gap-1.5" role="group" aria-label="Visualization mode">
          {MODES.map(m => (
            <Button
              variant="bare"
              key={m}
              onClick={() => setFullscreenMode(m)}
              aria-pressed={fullscreenMode === m}
              className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${
                fullscreenMode === m
                  ? "bg-accent font-semibold"
                  : "bg-white/10 text-white/70 hover:bg-white/20"
              }`}
              style={fullscreenMode === m ? { color: "var(--artwork-ink, #000)" } : undefined}
            >
              {m}
            </Button>
          ))}
        </div>
        </div>
        {fullscreenError && <p role="status" className="mt-3 text-sm text-white/70">{fullscreenError}</p>}
      </div>
    </div>,
    document.body
  )
}
