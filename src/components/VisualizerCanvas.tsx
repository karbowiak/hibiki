import { useCallback, useRef, useMemo, useEffect } from "react"
import type { LevelData } from "../providers/types"
import { useVisualizerStore, type CompactVisualizerMode } from "../stores/visualizerStore"
import { useEasterEggStore } from "../stores/easterEggStore"
import { usePlayerStore } from "../stores/playerStore"
import { useAccentStore } from "../stores/accentStore"
import { useVisualizationVisibility } from "../hooks/useVisualizationVisibility"
import { useVisualizationFrames } from "../hooks/useVisualizationFrames"
import { computeSpectrumFromFFT } from "../lib/visualizerSpectrum"
import { useArtworkPaletteRevision } from "../lib/artworkPaletteContext"

import { normalizeWaveformLoudness, waveformBarGeometry, clampWaveformProgress } from "../lib/waveformGeometry"

// ---------------------------------------------------------------------------
// Accent colour helpers — reads CSS var so canvas matches the theme accent
// ---------------------------------------------------------------------------

function readAccent(el: HTMLElement): string {
  return getComputedStyle(el).getPropertyValue("--accent").trim() || "#d946ef"
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
  const paletteRevision = useArtworkPaletteRevision()

  // Preprocess waveform bars from levels (memoised — only changes when levels change)
  const waveformBars = useMemo(
    () => (levels ? normalizeWaveformLoudness(levels) : null),
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
    let pixelRatio = 1
    if (mode === "waveform") {
      const bounds = canvas.getBoundingClientRect()
      pixelRatio = Math.max(1, Math.min(4, window.devicePixelRatio || 1))
      if (bounds.width > 0 && bounds.height > 0) {
        const width = Math.max(1, Math.round(bounds.width * pixelRatio))
        const height = Math.max(1, Math.round(bounds.height * pixelRatio))
        if (canvas.width !== width) canvas.width = width
        if (canvas.height !== height) canvas.height = height
      }
    } else {
      // Existing animated modes retain their original rendering coordinates.
      if (canvas.width !== 800) canvas.width = 800
      if (canvas.height !== 28) canvas.height = 28
    }
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

    if (mode === "waveform") {
      // A quiet symmetric strip, with real played progress and a hover ghost.
      const styles = getComputedStyle(canvas)
      const primary = styles.getPropertyValue("--artwork-primary").trim() || accent
      const ink = styles.getPropertyValue("--text-secondary").trim() || styles.getPropertyValue("--text-muted").trim() || "#777"
      const bars = waveformBarGeometry(waveformBars ?? [], W, H, pixelRatio)
      const paint = () => { for (const bar of bars) ctx.fillRect(bar.x, bar.y, bar.width, bar.height) }
      ctx.save()
      ctx.fillStyle = ink
      ctx.globalAlpha = 0.28
      paint()
      ctx.globalAlpha = 1
      ctx.fillStyle = primary
      if (rainbow) {
        const gradient = ctx.createLinearGradient(0, 0, W, 0)
        for (let i = 0; i <= 6; i++) gradient.addColorStop(i / 6, `hsl(${(rainbowPhase + i / 6 * 360) % 360}, 85%, 60%)`)
        ctx.fillStyle = gradient
      }
      const playedX = clampWaveformProgress(progressPct) / 100 * W
      ctx.save()
      ctx.beginPath(); ctx.rect(0, 0, playedX, H); ctx.clip()
      paint()
      ctx.restore()
      if (hoverPct !== null) {
        const hoveredX = clampWaveformProgress(hoverPct) / 100 * W
        if (hoveredX > playedX) {
          ctx.save()
          ctx.globalAlpha = 0.4
          ctx.beginPath(); ctx.rect(playedX, 0, hoveredX - playedX, H); ctx.clip()
          paint()
          ctx.restore()
        }
        ctx.fillStyle = primary
        ctx.globalAlpha = 0.7
        const ghostWidth = Math.min(W, pixelRatio)
        ctx.fillRect(Math.max(0, Math.min(W - ghostWidth, hoveredX)), 0, ghostWidth, H)
      }
      ctx.restore()
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
  }, [mode, waveformBars, progressPct, hoverPct, getRecentSamples, getFrequencyData, getSampleRate, isPlaying, rainbow, accentColor, colors, paletteRevision])

  const drawRef = useRef(draw)
  drawRef.current = draw
  useEffect(() => {
    if (mode !== "waveform" || !visible || !canvasRef.current || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => drawRef.current())
    observer.observe(canvasRef.current)
    return () => observer.disconnect()
  }, [mode, visible])

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
