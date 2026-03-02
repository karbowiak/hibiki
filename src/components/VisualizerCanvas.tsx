import { useCallback, useEffect, useRef, useMemo } from "react"
import type { Level } from "../types/plex"
import { useVisualizerStore, type CompactVisualizerMode } from "../stores/visualizerStore"

// ---------------------------------------------------------------------------
// Waveform math (Catmull-Rom spline — mirrors the SVG WaveformSVG logic)
// ---------------------------------------------------------------------------

const WAVEFORM_BARS = 200
const MIN_AMP = 1.5
const WAVEFORM_SCALE = 0.78 // cap waveform at 78% of half-height — leaves breathing room like PlexAmp

function processLoudnessData(levels: Level[]): number[] {
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
// DFT for spectrum mode — logarithmically-spaced bins so bass/mid/treble each
// get a fair share of display space rather than bass dominating all columns.
// ---------------------------------------------------------------------------

function computeSpectrum(samples: Float32Array, bins: number): Float32Array {
  const N = Math.min(samples.length, 1024)
  const result = new Float32Array(bins)
  // Logarithmic frequency mapping: bin 0 ≈ 1 DFT component, bin 63 ≈ N/2
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
    // Square-root compress so quiet bins are still visible
    // Heavy compression (^0.15 instead of ^0.25) so the 50× bass/treble energy
    // gap compresses to ~2.5× visually — no tilt hack needed.
    result[b] = Math.pow(Math.sqrt(real * real + imag * imag) / N, 0.15)
  }
  // Cubic attenuation: bass ×0.4, mids ×0.45, highs ×0.8.
  for (let b = 0; b < bins; b++) {
    const t = b / (bins - 1)
    result[b] *= (0.4 + 0.4 * t * t * t) * 0.9
  }
  return result
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  /** Current playback progress 0–100 */
  progressPct: number
  /** Hover position 0–100, or null when not hovering */
  hoverPct: number | null
  /** Waveform levels from Plex */
  levels: Level[] | null
  mode: CompactVisualizerMode
}

export default function VisualizerCanvas({
  progressPct,
  hoverPct,
  levels,
  mode,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const specSmoothedRef = useRef<Float32Array | null>(null)
  const getRecentSamples = useVisualizerStore(s => s.getRecentSamples)

  // Preprocess waveform bars from levels (memoised — only changes when levels change)
  const waveformBars = useMemo(
    () => (levels ? processLoudnessData(levels) : null),
    [levels],
  )

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const W = canvas.width
    const H = canvas.height

    ctx.clearRect(0, 0, W, H)

    const accent = readAccent(canvas)
    const activePct = hoverPct ?? progressPct
    const splitX = (activePct / 100) * W
    const isHovering = hoverPct !== null

    if (mode === "waveform") {
      // ── Catmull-Rom waveform ──
      const bars = waveformBars ?? Array(WAVEFORM_BARS).fill(0.15)
      // Clamp offset to (0,1) exclusive — addColorStop throws IndexSizeError if
      // the value is outside [0,1], which happens when positionMs overshoots
      // duration by even a tiny amount due to floating-point drift.
      const stopOffset = Math.max(0.0001, Math.min(0.9999, activePct / 100))
      if (activePct > 0 && activePct < 100) {
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
      const pcm = getRecentSamples(1024)
      const BINS = 64
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
        const barH = Math.max(2, (smoothed[i] / maxVal) * H * 0.9)
        const barX = x + barW * 0.1
        const barWidth = barW * 0.8
        ctx.fillStyle = x + barW / 2 < splitX
          ? (isHovering ? hexToRgba(accent, 0.5) : accent)
          : "#404040"
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
      const pcm = getRecentSamples(512)
      ctx.strokeStyle = "#e0e0e0"
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
      const pcm = getRecentSamples(2048)
      // Compute RMS for left and right channels (odd = R, even = L)
      let sumL = 0, sumR = 0, countLR = 0
      for (let i = 0; i < pcm.length - 1; i += 2) {
        sumL += pcm[i] * pcm[i]
        sumR += pcm[i + 1] * pcm[i + 1]
        countLR++
      }
      const rmsL = countLR > 0 ? Math.sqrt(sumL / countLR) : 0
      const rmsR = countLR > 0 ? Math.sqrt(sumR / countLR) : 0
      const drawVU = (rms: number, y: number, h: number) => {
        const db = rms > 0 ? 20 * Math.log10(rms) : -60
        const pctFill = Math.max(0, Math.min(1, (db + 60) / 60)) * W
        // accent → yellow → red gradient
        const grad2 = ctx.createLinearGradient(0, 0, W, 0)
        grad2.addColorStop(0, accent)
        grad2.addColorStop(0.7, accent)
        grad2.addColorStop(0.85, "#f0c040")
        grad2.addColorStop(1, "#e04040")
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
  }, [mode, waveformBars, progressPct, hoverPct, getRecentSamples])

  // Animation loop
  useEffect(() => {
    let cancelled = false
    function loop() {
      if (cancelled) return
      draw()
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
    }
  }, [draw])

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
