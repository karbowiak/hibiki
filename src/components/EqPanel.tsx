import { useCallback, useRef } from "react"
import { useEqStore, EQ_LABELS, EQ_PRESETS } from "../stores/eqStore"

const MIN_DB = -12
const MAX_DB = 12
const DB_RANGE = MAX_DB - MIN_DB
const BAR_HEIGHT = 200

function dbToY(db: number): number {
  return ((MAX_DB - db) / DB_RANGE) * BAR_HEIGHT
}

function formatDb(db: number): string {
  if (db > 0) return `+${db}`
  return `${db}`
}

/** Custom visual gain slider with accent fill and glow thumb. */
function GainSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const pct = ((value + 12) / 24) * 100
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[10px] text-[color:var(--text-muted)]">{label}</span>
      <div className="relative flex flex-1 items-center" style={{ height: 20 }}>
        {/* Track background */}
        <div className="absolute inset-x-0 h-[3px] rounded-full bg-[var(--border)]" />
        {/* Filled portion */}
        <div
          className="absolute left-0 h-[3px] rounded-full bg-accent/40"
          style={{ width: `${pct}%` }}
        />
        {/* Native range input (invisible, handles interaction) */}
        <input
          type="range"
          min={-12}
          max={12}
          step={0.5}
          value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          className="absolute inset-0 w-full cursor-pointer opacity-0"
          aria-label={`${label}: ${value} dB`}
        />
        {/* Visual thumb */}
        <div
          className="pointer-events-none absolute h-3 w-3 rounded-full bg-accent"
          style={{
            left: `calc(${pct}% - 6px)`,
            boxShadow: "0 0 6px rgb(var(--accent-rgb) / 0.15)",
          }}
        />
      </div>
      <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-[color:var(--text-muted)]">
        {value > 0 ? "+" : ""}{value} dB
      </span>
    </div>
  )
}

interface Props {
  onClose: () => void
}

export default function EqPanel({ onClose }: Props) {
  const {
    gains, enabled, setEnabled, setBand, applyPreset,
    postgainDb, autoPostgain, setPostgainDb, setAutoPostgain,
    currentDevice, deviceProfiles, saveProfileForDevice, deleteProfileForDevice,
  } = useEqStore()

  const profileDevices = Object.keys(deviceProfiles)
  const barRefs = useRef<(HTMLDivElement | null)[]>([])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, index: number) => {
    if (!enabled) return
    e.preventDefault()
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    el.setPointerCapture(e.pointerId)

    const yToDb = (clientY: number) => {
      const relY = Math.max(0, Math.min(BAR_HEIGHT, clientY - rect.top))
      return Math.round(MAX_DB - (relY / BAR_HEIGHT) * DB_RANGE)
    }

    setBand(index, yToDb(e.clientY))

    const onMove = (ev: PointerEvent) => setBand(index, yToDb(ev.clientY))
    const onUp = () => {
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
      el.removeEventListener("lostpointercapture", onUp)
    }
    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
    el.addEventListener("lostpointercapture", onUp)
  }, [enabled, setBand])

  const handleKeyDown = useCallback((e: React.KeyboardEvent, index: number) => {
    if (!enabled) return
    let delta = 0
    if (e.key === "ArrowUp") delta = 1
    else if (e.key === "ArrowDown") delta = -1
    else if (e.key === "PageUp") delta = 3
    else if (e.key === "PageDown") delta = -3
    else if (e.key === "Home") { setBand(index, MAX_DB); e.preventDefault(); return }
    else if (e.key === "End") { setBand(index, MIN_DB); e.preventDefault(); return }
    else return
    e.preventDefault()
    setBand(index, Math.max(MIN_DB, Math.min(MAX_DB, gains[index] + delta)))
  }, [enabled, gains, setBand])

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="flex flex-col">
          <span className="text-sm font-bold text-[color:var(--text-primary)]">Equalizer</span>
          {currentDevice && (
            <span className="text-[10px] text-[color:var(--text-muted)] truncate max-w-[180px]">{currentDevice}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => applyPreset([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])}
            className="rounded-full px-2 py-0.5 text-[10px] font-medium text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] transition-colors"
          >
            Reset
          </button>
          <button
            onClick={() => setEnabled(!enabled)}
            className={`text-xs font-medium px-3 py-1 rounded-full transition-colors ${
              enabled
                ? "bg-accent text-[color:var(--bg-base)]"
                : "bg-[var(--bg-surface)] text-[color:var(--text-muted)]"
            }`}
          >
            {enabled ? "ON" : "OFF"}
          </button>
        </div>
      </div>

      {/* Preset grid */}
      <div className={`grid grid-cols-3 gap-1.5 px-4 py-3 border-b border-[var(--border)] transition-opacity ${!enabled ? "opacity-40 pointer-events-none" : ""}`}>
        {EQ_PRESETS.map((preset) => {
          const active = preset.gains.every((g, i) => Math.abs(g - gains[i]) < 0.01)
          return (
            <button
              key={preset.name}
              onClick={() => applyPreset(preset.gains)}
              className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-all ${
                active
                  ? "border-accent/50 text-accent"
                  : "border-[var(--border)] text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]"
              }`}
              style={{
                background: active ? "var(--accent-tint-strong)" : "var(--accent-tint-subtle)",
                ...(active ? { boxShadow: "0 0 8px rgb(var(--accent-rgb) / 0.15)" } : {}),
              }}
            >
              {preset.name}
            </button>
          )
        })}
      </div>

      {/* EQ Bars */}
      <div className={`px-4 pt-4 pb-2 transition-opacity ${!enabled ? "opacity-40 pointer-events-none" : ""}`}>
        <div className="relative flex items-start justify-between gap-1">
          {/* 0dB reference line */}
          <div
            className="pointer-events-none absolute left-0 right-0 border-t border-[var(--border)]"
            style={{ top: `calc(24px + ${BAR_HEIGHT / 2}px)` }}
          />

          {gains.map((db, i) => {
            const centerY = BAR_HEIGHT / 2
            const currentY = dbToY(db)
            const fillTop = db >= 0 ? currentY : centerY
            const fillHeight = db >= 0 ? centerY - currentY : currentY - centerY

            return (
              <div key={i} className="flex flex-col items-center gap-1">
                {/* dB value */}
                <span className={`h-4 text-[10px] tabular-nums leading-4 ${
                  db === 0 ? "text-[color:var(--text-muted)]" : "text-[color:var(--text-primary)]"
                }`}>
                  {formatDb(db)}
                </span>

                {/* Bar */}
                <div
                  ref={el => { barRefs.current[i] = el }}
                  role="slider"
                  tabIndex={0}
                  aria-valuemin={MIN_DB}
                  aria-valuemax={MAX_DB}
                  aria-valuenow={db}
                  aria-label={`${EQ_LABELS[i]} Hz band`}
                  className="relative cursor-pointer overflow-hidden rounded-md bg-[var(--bg-surface)] focus-visible:ring-2 focus-visible:ring-accent"
                  style={{ width: 32, height: BAR_HEIGHT }}
                  onPointerDown={e => handlePointerDown(e, i)}
                  onDoubleClick={() => enabled && setBand(i, 0)}
                  onKeyDown={e => handleKeyDown(e, i)}
                >
                  {/* Fill from center */}
                  {fillHeight > 0 && (
                    <div
                      className="absolute left-1 right-1 rounded-sm bg-accent/30"
                      style={{ top: fillTop, height: fillHeight }}
                    />
                  )}

                  {/* Thumb line */}
                  <div
                    className="absolute left-0.5 right-0.5 h-[3px] rounded-full bg-accent"
                    style={{
                      top: currentY - 1.5,
                      boxShadow: "0 0 6px rgb(var(--accent-rgb) / 0.15)",
                    }}
                  />
                </div>

                {/* Frequency label */}
                <span className="text-[9px] tabular-nums text-[color:var(--text-muted)]">
                  {EQ_LABELS[i]}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Gain controls */}
      <div className={`px-4 py-3 space-y-2 border-t border-[var(--border)] transition-opacity ${!enabled ? "opacity-40 pointer-events-none" : ""}`}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[11px] text-[color:var(--text-muted)] shrink-0">Gain</span>
          <button
            onClick={() => setAutoPostgain(!autoPostgain)}
            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors shrink-0 ${
              autoPostgain
                ? "bg-accent text-[color:var(--bg-base)]"
                : "bg-[var(--bg-surface)] text-[color:var(--text-muted)] hover:bg-[var(--bg-surface-hover)]"
            }`}
          >
            Auto
          </button>
          {autoPostgain && (
            <span className="text-[11px] text-[color:var(--text-muted)] tabular-nums">
              +{postgainDb.toFixed(1)} dB
            </span>
          )}
        </div>
        {!autoPostgain && (
          <GainSlider label="Postgain" value={postgainDb} onChange={setPostgainDb} />
        )}
      </div>

      {/* Device Profiles */}
      {profileDevices.length > 0 && (
        <div className={`px-4 py-2 border-t border-[var(--border)] transition-opacity ${!enabled ? "opacity-40 pointer-events-none" : ""}`}>
          <span className="text-[11px] text-[color:var(--text-muted)] font-semibold uppercase tracking-wider">Device Profiles</span>
          <div className="mt-1.5 flex flex-col gap-1">
            {profileDevices.map((dev) => {
              const hasProfile = !!deviceProfiles[dev]
              const isActive = dev === currentDevice
              return (
                <div
                  key={dev}
                  className={`flex items-center gap-2 py-1 px-2 rounded text-xs ${
                    isActive ? "bg-[var(--accent-tint-subtle)]" : ""
                  }`}
                >
                  {isActive && (
                    <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                  )}
                  <span className={`truncate flex-1 ${
                    isActive ? "text-[color:var(--text-primary)]" : "text-[color:var(--text-muted)]"
                  }`}>
                    {dev}
                  </span>
                  {hasProfile && (
                    <svg className="w-3 h-3 text-accent shrink-0" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
                    </svg>
                  )}
                  <button
                    onClick={() => saveProfileForDevice(dev)}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-surface)] text-[color:var(--text-muted)] hover:bg-[var(--bg-surface-hover)] hover:text-[color:var(--text-primary)] transition-colors shrink-0"
                  >
                    Save
                  </button>
                  {hasProfile && (
                    <button
                      onClick={() => deleteProfileForDevice(dev)}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-surface)] text-[color:var(--text-muted)] hover:bg-red-500/20 hover:text-red-400 transition-colors shrink-0"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
