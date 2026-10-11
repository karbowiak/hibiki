import { useEffect, useId, useRef, useState } from "react"
import { useEasterEggStore } from "../stores/easterEggStore"

interface Props {
  volume: number
  onChange: (v: number) => void
}

const WIDTH = 128
const HEIGHT = 28
const PAD_X = 6
const TRACK_WIDTH = WIDTH - PAD_X * 2
const MID_Y = HEIGHT / 2

const BASE_CYCLES = 6
const MAX_AMP = 7
/** How fast the squiggle decays back to straight (0–1, lower = slower) */
const DECAY = 0.06

function buildWavePath(pct: number, amplitude: number, phase: number): string {
  const filledW = TRACK_WIDTH * (pct / 100)
  if (filledW < 1) return `M ${PAD_X} ${MID_Y} L ${PAD_X} ${MID_Y}`

  const steps = Math.max(Math.round(filledW), 2)
  const pts: string[] = []
  for (let i = 0; i <= steps; i++) {
    const x = PAD_X + (i / steps) * filledW
    const t = (i / steps) * BASE_CYCLES * Math.PI * 2 + phase
    const y = MID_Y + Math.sin(t) * amplitude
    pts.push(`${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  return pts.join(" ")
}

const RAINBOW_STOPS = 5

export default function SquigglyVolumeSlider({ volume, onChange }: Props) {
  const gradientId = useId()

  // Animation state kept in refs to avoid re-renders on every frame
  const ampRef = useRef(0) // current rendered amplitude
  const targetAmp = useRef(0) // target amplitude (spikes on change, decays to 0)
  const phaseRef = useRef(0) // rolling phase offset
  const animRef = useRef<number | null>(null)
  const prevVolume = useRef(volume)
  const rainbowMode = useEasterEggStore((s) => s.rainbow)

  // Rainbow hue offset — drives gradient stop colors via React state
  const [rainbowHue, setRainbowHue] = useState(0)

  // We only trigger React re-renders via this single state value
  const [, forceRender] = useState(0)

  // Animate only while a changed volume has a visible wave.
  useEffect(() => {
    const delta = Math.abs(volume - prevVolume.current)
    prevVolume.current = volume
    if (delta < 0.5) return
    targetAmp.current = Math.min(
      MAX_AMP,
      (volume / 100) * MAX_AMP + delta * 0.1
    )
    phaseRef.current += delta * 0.2
    if (animRef.current !== null) return

    const tick = () => {
      targetAmp.current *= 1 - DECAY
      if (targetAmp.current < 0.01) targetAmp.current = 0
      ampRef.current += (targetAmp.current - ampRef.current) * 0.2
      if (ampRef.current > 0.01) {
        phaseRef.current += 0.12
        forceRender((n) => n + 1)
        animRef.current = requestAnimationFrame(tick)
      } else {
        ampRef.current = 0
        animRef.current = null
        forceRender((n) => n + 1)
      }
    }
    animRef.current = requestAnimationFrame(tick)
  }, [volume])

  useEffect(
    () => () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current)
      animRef.current = null
    },
    []
  )

  // Rainbow color cycling — separate interval so it doesn't depend on the squiggle
  useEffect(() => {
    if (!rainbowMode) return
    const id = setInterval(() => {
      setRainbowHue((performance.now() / 50) % 360)
    }, 33) // ~30fps — smooth enough for color shifting
    return () => clearInterval(id)
  }, [rainbowMode])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    let next: number
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = volume + 1
        break
      case "ArrowLeft":
      case "ArrowDown":
        next = volume - 1
        break
      case "PageUp":
        next = volume + 10
        break
      case "PageDown":
        next = volume - 10
        break
      case "Home":
        next = 0
        break
      case "End":
        next = 100
        break
      default:
        return
    }
    event.preventDefault()
    const clamped = Math.max(0, Math.min(100, next))
    if (clamped !== volume) onChange(clamped)
  }

  const amp = ampRef.current
  const phase = phaseRef.current
  const activePath = buildWavePath(volume, amp, phase)

  const inactiveX = PAD_X + TRACK_WIDTH * (volume / 100)
  const inactivePath = `M ${inactiveX.toFixed(2)} ${MID_Y} L ${(PAD_X + TRACK_WIDTH).toFixed(2)} ${MID_Y}`

  const knobX = PAD_X + TRACK_WIDTH * (volume / 100)
  const knobT = BASE_CYCLES * Math.PI * 2 + phase
  const knobY = MID_Y + Math.sin(knobT) * amp

  return (
    <div
      className="relative select-none rounded-md focus-within:ring-2 focus-within:ring-[var(--accent)]"
      style={{ width: WIDTH, height: HEIGHT }}
    >
      <svg
        width={WIDTH}
        height={HEIGHT}
        className="block"
        aria-hidden="true"
        focusable="false"
      >
        {rainbowMode && (
          <defs>
            <linearGradient
              id={gradientId}
              gradientUnits="userSpaceOnUse"
              x1={PAD_X}
              y1={0}
              x2={PAD_X + TRACK_WIDTH * (volume / 100)}
              y2={0}
            >
              {Array.from({ length: RAINBOW_STOPS }, (_, i) => {
                const hue = (rainbowHue + (i / (RAINBOW_STOPS - 1)) * 360) % 360
                return (
                  <stop
                    key={i}
                    offset={`${(i / (RAINBOW_STOPS - 1)) * 100}%`}
                    stopColor={`hsl(${hue}, 85%, 60%)`}
                  />
                )
              })}
            </linearGradient>
          </defs>
        )}
        <path
          d={inactivePath}
          fill="none"
          stroke="#535353"
          strokeWidth={2}
          strokeLinecap="round"
        />
        <path
          d={activePath}
          fill="none"
          stroke={rainbowMode ? `url(#${gradientId})` : "var(--accent)"}
          strokeWidth={2}
          strokeLinecap="round"
        />
        <circle
          cx={knobX}
          cy={knobY}
          r={5}
          fill="white"
          style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.3))" }}
        />
      </svg>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={volume}
        aria-label="Volume"
        aria-valuetext={`${volume}%`}
        onInput={(event) => onChange(event.currentTarget.valueAsNumber)}
        onKeyDown={onKeyDown}
        className="volume-slider absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0"
      />
    </div>
  )
}
