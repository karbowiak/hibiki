import { useEffect, useRef } from "react"
import { useEqStore, EQ_LABELS, EQ_PRESETS } from "../stores/eqStore"

const MIN_DB = -12
const MAX_DB = 12
const SLIDER_HEIGHT = 120 // px — visual height of the vertical slider track

// Correct geometry for the rotated slider:
// Container: W=20px, H=SLIDER_HEIGHT
// Input before rotation: width=SLIDER_HEIGHT, height=20px
// With transformOrigin:"center center" and rotate(-90deg), the 4 corners map to
// (0,0),(20,0),(0,H),(20,H) — perfectly inside the container — when positioned at:
//   left = -(SLIDER_HEIGHT - 20) / 2
//   top  =  (SLIDER_HEIGHT - 20) / 2
const SLIDER_LEFT = -((SLIDER_HEIGHT - 20) / 2)
const SLIDER_TOP  =   (SLIDER_HEIGHT - 20) / 2

export default function EqPanel() {
  const { gains, enabled, setEnabled, setBand, applyPreset, setEqOpen } = useEqStore()
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setEqOpen(false)
      }
    }
    document.addEventListener("mousedown", onMouseDown)
    return () => document.removeEventListener("mousedown", onMouseDown)
  }, [setEqOpen])

  // Close on Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setEqOpen(false)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [setEqOpen])

  return (
    <div
      ref={panelRef}
      className="absolute bottom-full right-0 mb-2 z-50 w-[460px] rounded-xl bg-app-card border border-[var(--border)] shadow-2xl select-none"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <span className="text-sm font-semibold text-white tracking-wide">Equalizer</span>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setEnabled(!enabled)}
            className={`text-xs font-bold px-3 py-1 rounded-full transition-colors ${
              enabled
                ? "bg-accent text-black"
                : "bg-white/10 text-white/50 hover:bg-white/20"
            }`}
          >
            {enabled ? "ON" : "OFF"}
          </button>
          <button
            onClick={() => setEqOpen(false)}
            className="text-white/40 hover:text-white transition-colors"
            aria-label="Close EQ"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.293 4.293a1 1 0 011.414 0L8 6.586l2.293-2.293a1 1 0 111.414 1.414L9.414 8l2.293 2.293a1 1 0 01-1.414 1.414L8 9.414l-2.293 2.293a1 1 0 01-1.414-1.414L6.586 8 4.293 5.707a1 1 0 010-1.414z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Preset pills */}
      <div className={`flex flex-wrap gap-1.5 px-4 py-3 border-b border-[var(--border)] transition-opacity ${!enabled ? "opacity-40 pointer-events-none" : ""}`}>
        {EQ_PRESETS.map((preset) => {
          const active = preset.gains.every((g, i) => Math.abs(g - gains[i]) < 0.01)
          return (
            <button
              key={preset.name}
              onClick={() => applyPreset(preset.gains)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                active
                  ? "bg-accent text-black font-semibold"
                  : "bg-white/10 text-white/70 hover:bg-white/20"
              }`}
            >
              {preset.name}
            </button>
          )
        })}
      </div>

      {/* Sliders — overflow:hidden clips any sub-pixel thumb bleed at track extremes */}
      <div className={`px-4 pt-4 pb-4 transition-opacity overflow-hidden ${!enabled ? "opacity-40 pointer-events-none" : ""}`}>
        <div className="flex items-start justify-between gap-1">
          {gains.map((db, i) => (
            <div key={i} className="flex flex-col items-center gap-1" style={{ width: 36 }}>
              {/* Current dB value — sits directly above the slider top */}
              <span className="text-[10px] text-white/60 text-center w-full leading-none">
                {db > 0 ? `+${db}` : db === 0 ? "0" : db}
              </span>

              {/* Slider container — sized to exactly match the rotated slider's visual footprint */}
              <div style={{ position: "relative", width: 20, height: SLIDER_HEIGHT }}>
                <input
                  type="range"
                  min={MIN_DB}
                  max={MAX_DB}
                  step={0.5}
                  value={db}
                  onChange={(e) => setBand(i, parseFloat(e.target.value))}
                  className="eq-slider appearance-none cursor-pointer"
                  style={{
                    position: "absolute",
                    width: SLIDER_HEIGHT,
                    height: 20,
                    left: SLIDER_LEFT,
                    top: SLIDER_TOP,
                    transform: "rotate(-90deg)",
                    transformOrigin: "center center",
                    background: "transparent",
                  }}
                  aria-label={`${EQ_LABELS[i]} Hz: ${db} dB`}
                />
              </div>

              {/* Frequency label */}
              <span className="text-[10px] text-white/40 text-center w-full leading-none">
                {EQ_LABELS[i]}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
