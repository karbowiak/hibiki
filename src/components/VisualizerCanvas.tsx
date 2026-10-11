import { useCallback, useRef, useMemo } from "react"
import type { LevelData } from "../providers/types"
import { useVisualizerStore, type CompactVisualizerMode } from "../stores/visualizerStore"
import { useEasterEggStore } from "../stores/easterEggStore"
import { usePlayerStore } from "../stores/playerStore"
import { useAccentStore } from "../stores/accentStore"
import { useVisualizationVisibility } from "../hooks/useVisualizationVisibility"
import { useVisualizationFrames } from "../hooks/useVisualizationFrames"
import { computeSpectrumFromFFT } from "../lib/visualizerSpectrum"

// ---------------------------------------------------------------------------
// Waveform math (Catmull-Rom spline — mirrors the SVG WaveformSVG logic)
// ---------------------------------------------------------------------------

const WAVEFORM_BARS = 200
const MIN_AMP = 1.5
const WAVEFORM_SCALE = 0.78 // cap waveform at 78% of half-height — leaves breathing room like PlexAmp

function processLoudnessData(levels: LevelData[]): number[] {
  if (levels.length === 0) return Array(WAVEFORM_BARS).fill(MIN_AMP / 14)
  // Mirrors PlexAmp's ProcessLoudnessData: dBFS floor → quadratic boost → power curve → normalise
  let vals = levels.map(l => {
    const t = (Math.max(l.loudness, -35) + 35) * (100 / 35)
    const boosted = t * t / 100 * 1.5
    return isFinite(boosted) ? boosted : 3
  })
  const max1 = Math.max(...vals, 0.01)
  vals = vals.map(v => v * (90 / 2.2) / max1)
  const curved = vals.map(v => Math.pow(Math.max(0, v), 1.2) / 2.4)
  const max2 = Math.max(...curved, 0.01)
  const normalised = curved.map(v => v / max2)
  // Linear interpolation to exactly WAVEFORM_BARS (smoother than nearest-neighbour)
  if (normalised.length === WAVEFORM_BARS) return normalised
  const out: number[] = new Array(WAVEFORM_BARS)
  const step = (normalised.length - 1) / (WAVEFORM_BARS - 1)
  out[0] = normalised[0]
  for (let i = 1; i < WAVEFORM_BARS - 1; i++) {
    const pos = i * step
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    out[i] = normalised[lo] + (normalised[hi] - normalised[lo]) * (pos - lo)
  }
  out[WAVEFORM_BARS - 1] = normalised[normalised.length - 1]
  return out
}

// `move` controls whether to call moveTo at pts[0] — pass false to continue
// an existing path segment (e.g. for the bottom half of a waveform).
function catmullRomCanvas(
  ctx: CanvasRenderingContext2D,
  pts: Array<{ x: number; y: number }>,
  move: boolean,
) {
  const n = pts.length
  if (move) ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(n - 1, i + 2)]
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
  }
}

function buildWaveformPath(
  ctx: CanvasRenderingContext2D,
  bars: number[],
  W: number,
  H: number,
) {
  const mid = H / 2
  const n = bars.length
  const topPts = bars.map((v, i) => ({
    x: (i / (n - 1)) * W,
    y: mid - Math.max(MIN_AMP, v * mid * WAVEFORM_SCALE),
  }))
  const botPts = [...bars].reverse().map((v, i) => ({
    x: ((n - 1 - i) / (n - 1)) * W,
    y: mid + Math.max(MIN_AMP, v * mid * WAVEFORM_SCALE),
  }))
  ctx.beginPath()
  catmullRomCanvas(ctx, topPts, true)            // moveTo topLeft, curve to topRight
  ctx.lineTo(botPts[0].x, botPts[0].y)           // connect topRight → botRight
  catmullRomCanvas(ctx, botPts, false)            // continue: curve botRight → botLeft
  ctx.closePath()                                 // close: botLeft → topLeft
}

// ---------------------------------------------------------------------------
// Accent colour helpers — reads CSS var so canvas matches the theme accent
// ---------------------------------------------------------------------------

function readAccent(el: HTMLElement): string {
  return getComputedStyle(el).getPropertyValue("--accent").trim() || "#d946ef"
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function lerpHex(a: string, b: string, t: number): string {
  const r = Math.round(parseInt(a.slice(1, 3), 16) * (1 - t) + parseInt(b.slice(1, 3), 16) * t)
  const g = Math.round(parseInt(a.slice(3, 5), 16) * (1 - t) + parseInt(b.slice(3, 5), 16) * t)
  const bl = Math.round(parseInt(a.slice(5, 7), 16) * (1 - t) + parseInt(b.slice(5, 7), 16) * t)
  return `rgb(${r},${g},${bl})`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  /** Current playback progress 0–100 */
  progressPct: number
  /** Hover position 0–100, or null when not hovering */
  hoverPct: number | null
  /** Waveform levels from Plex */
  levels: LevelData[] | null
  mode: CompactVisualizerMode
}

export default function VisualizerCanvas({
  progressPct,
  hoverPct,
  levels,
  mode,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const specSmoothedRef = useRef<Float32Array | null>(null)
  const getRecentSamples = useVisualizerStore(s => s.getRecentSamples)
  const getFrequencyData = useVisualizerStore(s => s.getFrequencyData)
  const getSampleRate = useVisualizerStore(s => s.getSampleRate)
  const colors = useVisualizerStore(s => `${s.vizColorLow},${s.vizColorMid},${s.vizColorHigh}`)
  const isPlaying = usePlayerStore(s => s.isPlaying)
  const rainbow = useEasterEggStore(s => s.rainbow)
  const accentColor = useAccentStore(s => s.accent)
  const visible = useVisualizationVisibility()

  // Preprocess waveform bars from levels (memoised — only changes when levels change)
  const waveformBars = useMemo(
    () => (levels ? processLoudnessData(levels) : null),
    [levels],
  )

  // Cache accent colour — only read from DOM when not in rainbow mode, and
  // throttle reads to avoid forcing synchronous style recalculation every frame.
  const cachedAccentRef = useRef<string>("#d946ef")
  const accentTickRef = useRef(0)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const W = canvas.width
    const H = canvas.height

    ctx.clearRect(0, 0, W, H)

    const rainbowPhase = (performance.now() / 50) % 360

    // In rainbow mode the canvas draws its own gradient — skip getComputedStyle.
    // Otherwise refresh the cached accent every ~30 frames (~500ms at 60fps).
    let accent = cachedAccentRef.current
    if (!rainbow) {
      if (++accentTickRef.current >= 30 || mode === "waveform") {
        accentTickRef.current = 0
        accent = readAccent(canvas)
        cachedAccentRef.current = accent
      }
    }

    const activePct = hoverPct ?? progressPct
    const splitX = (activePct / 100) * W
    const isHovering = hoverPct !== null

    if (mode === "waveform") {
      // ── Catmull-Rom waveform ──
      const bars = waveformBars ?? Array(WAVEFORM_BARS).fill(0.15)
      const stopOffset = Math.max(0.0001, Math.min(0.9999, activePct / 100))
      if (rainbow) {
        if (activePct <= 0) {
          ctx.fillStyle = "#404040"
        } else {
          const grad = ctx.createLinearGradient(0, 0, W, 0)
          for (let i = 0; i <= 6; i++) {
            const hue = (rainbowPhase + (i / 6) * 360) % 360
            grad.addColorStop(Math.min((i / 6) * stopOffset, 0.9999), `hsl(${hue}, 85%, 60%)`)
          }
          if (activePct < 100) {
            grad.addColorStop(Math.min(stopOffset + 0.0001, 1), "#404040")
            grad.addColorStop(1, "#404040")
          }
          ctx.fillStyle = grad
        }
      } else if (activePct > 0 && activePct < 100) {
        const grad = ctx.createLinearGradient(0, 0, W, 0)
        grad.addColorStop(stopOffset, isHovering ? hexToRgba(accent, 0.4) : accent)
        grad.addColorStop(stopOffset, "#404040")
        grad.addColorStop(1, "#404040")
        ctx.fillStyle = grad
      } else if (activePct <= 0) {
        ctx.fillStyle = "#404040"
      } else {
        ctx.fillStyle = isHovering ? hexToRgba(accent, 0.4) : accent
      }
      buildWaveformPath(ctx, bars, W, H)
      ctx.fill()
    } else if (mode === "spectrum") {
      // ── Spectrum bars ──
      const BINS = 64
      const fftData = isPlaying ? getFrequencyData() : null
      const raw = fftData ? computeSpectrumFromFFT(fftData, BINS, getSampleRate()) : new Float32Array(BINS)
      // Exponential moving average: fast attack (α=0.4), moderate release (α=0.18)
      if (!specSmoothedRef.current || specSmoothedRef.current.length !== BINS) {
        specSmoothedRef.current = new Float32Array(BINS)
      }
      const smoothed = specSmoothedRef.current
      for (let i = 0; i < BINS; i++) {
        const α = raw[i] > smoothed[i] ? 0.4 : 0.18
        smoothed[i] += α * (raw[i] - smoothed[i])
      }
      const { vizColorLow, vizColorMid, vizColorHigh } = useVisualizerStore.getState()
      const barW = W / BINS
      const maxVal = Math.max(...Array.from(smoothed), 0.001)
      for (let i = 0; i < BINS; i++) {
        const x = i * barW
        const barH = Math.max(2, (smoothed[i] / maxVal) * H * 0.9)
        const barX = x + barW * 0.1
        const barWidth = barW * 0.8
        if (rainbow) {
          ctx.fillStyle = `hsl(${(rainbowPhase + (i / BINS) * 360) % 360}, 85%, 60%)`
        } else if (x + barW / 2 >= splitX) {
          ctx.fillStyle = "#404040"
        } else {
          // Vertical gradient per bar: green (bottom) → yellow (mid) → red (top)
          const grad = ctx.createLinearGradient(barX, H, barX, H - barH)
          grad.addColorStop(0, vizColorLow)
          grad.addColorStop(0.5, vizColorMid)
          grad.addColorStop(1, vizColorHigh)
          ctx.fillStyle = grad
        }
        ctx.fillRect(barX, H - barH, barWidth, barH)
      }
      // Progress indicator
      ctx.strokeStyle = "rgba(255,255,255,0.25)"
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(splitX, 0)
      ctx.lineTo(splitX, H)
      ctx.stroke()
    } else if (mode === "oscilloscope") {
      // ── Oscilloscope line ──
      const pcm = isPlaying ? getRecentSamples(512) : new Float32Array(512)
      if (rainbow) {
        const oscGrad = ctx.createLinearGradient(0, 0, W, 0)
        for (let i = 0; i <= 6; i++) {
          const hue = (rainbowPhase + (i / 6) * 360) % 360
          oscGrad.addColorStop(i / 6, `hsl(${hue}, 85%, 60%)`)
        }
        ctx.strokeStyle = oscGrad
      } else {
        ctx.strokeStyle = "#e0e0e0"
      }
      ctx.lineWidth = 1.5
      ctx.beginPath()
      const mid = H / 2
      for (let i = 0; i < pcm.length; i++) {
        const x = (i / (pcm.length - 1)) * W
        const y = mid - pcm[i] * mid * 3.0
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      // Progress indicator
      ctx.strokeStyle = "rgba(255,255,255,0.2)"
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(splitX, 0)
      ctx.lineTo(splitX, H)
      ctx.stroke()
    } else if (mode === "vu") {
      // ── VU meter (two horizontal bars for L and R) ──
      const pcm = isPlaying ? getRecentSamples(2048) : new Float32Array(2048)
      // Compute RMS for left and right channels (odd = R, even = L)
      let sumL = 0, sumR = 0, countLR = 0
      for (let i = 0; i < pcm.length - 1; i += 2) {
        sumL += pcm[i] * pcm[i]
        sumR += pcm[i + 1] * pcm[i + 1]
        countLR++
      }
      const rmsL = countLR > 0 ? Math.sqrt(sumL / countLR) : 0
      const rmsR = countLR > 0 ? Math.sqrt(sumR / countLR) : 0
      const { vizColorLow: vuLow, vizColorMid: vuMid, vizColorHigh: vuHigh } = useVisualizerStore.getState()
      const drawVU = (rms: number, y: number, h: number) => {
        const db = rms > 0 ? 20 * Math.log10(rms) : -60
        const pctFill = Math.max(0, Math.min(1, (db + 60) / 60)) * W
        const grad2 = ctx.createLinearGradient(0, 0, W, 0)
        if (rainbow) {
          for (let j = 0; j <= 6; j++) {
            const hue = (rainbowPhase + (j / 6) * 360) % 360
            grad2.addColorStop(j / 6, `hsl(${hue}, 85%, 60%)`)
          }
        } else {
          grad2.addColorStop(0, vuLow)
          grad2.addColorStop(0.5, vuMid)
          grad2.addColorStop(0.85, vuMid)
          grad2.addColorStop(1, vuHigh)
        }
        ctx.fillStyle = "#333"
        ctx.fillRect(0, y, W, h)
        ctx.fillStyle = grad2
        ctx.fillRect(0, y, pctFill, h)
      }
      const pad = H * 0.1
      const barH = H * 0.35
      drawVU(rmsL, pad, barH)
      drawVU(rmsR, H - pad - barH, barH)
      // Channel labels
      ctx.fillStyle = "rgba(255,255,255,0.4)"
      ctx.font = "8px sans-serif"
      ctx.fillText("L", 4, pad + barH - 3)
      ctx.fillText("R", 4, H - pad - 3)
      // Progress indicator
      ctx.strokeStyle = "rgba(255,255,255,0.25)"
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(splitX, 0)
      ctx.lineTo(splitX, H)
      ctx.stroke()
    }
  }, [mode, waveformBars, progressPct, hoverPct, getRecentSamples, getFrequencyData, getSampleRate, isPlaying, rainbow, accentColor, colors])

  useVisualizationFrames(draw, (mode !== "waveform" && isPlaying) || rainbow, visible)

  return (
    <div className="relative h-7 w-full pointer-events-none">
      <canvas
        ref={canvasRef}
        width={800}
        height={28}
        className="absolute inset-0 w-full h-full"
        style={{ imageRendering: "pixelated" }}
      />
    </div>
  )
}
