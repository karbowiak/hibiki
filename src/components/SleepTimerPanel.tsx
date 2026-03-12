import { useEffect, useState } from "react"
import { useSleepTimerStore } from "../stores/sleepTimerStore"

const PRESETS = [
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
  { label: "45 min", value: 45 },
  { label: "1 hour", value: 60 },
  { label: "1.5 hr", value: 90 },
  { label: "2 hours", value: 120 },
]

function formatRemaining(endsAt: number): string {
  const ms = Math.max(0, endsAt - Date.now())
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, "0")}`
}

interface Props {
  onClose: () => void
}

export default function SleepTimerPanel({ onClose }: Props) {
  const { endsAt, endOfTrack, start, startEndOfTrack, cancel } = useSleepTimerStore()
  const [, forceUpdate] = useState(0)
  const [customMinutes, setCustomMinutes] = useState("")
  const isActive = !!(endsAt || endOfTrack)

  // Tick every second to update countdown
  useEffect(() => {
    if (!endsAt) return
    const id = setInterval(() => forceUpdate(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [endsAt])

  function handlePreset(min: number) {
    start(min)
    onClose()
  }

  function handleCustom() {
    const m = parseInt(customMinutes, 10)
    if (!m || m <= 0) return
    start(m)
    setCustomMinutes("")
    onClose()
  }

  // Check which preset is currently selected
  function isPresetSelected(min: number): boolean {
    if (!endsAt || endOfTrack) return false
    const remainingMin = Math.round((endsAt - Date.now()) / 60000)
    // Consider it "selected" if set within the last minute
    return Math.abs(remainingMin - min) <= 1
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <span className="text-sm font-bold text-[color:var(--text-primary)]">Sleep Timer</span>
        {isActive && (
          <button
            onClick={() => { cancel(); onClose() }}
            className="rounded-full px-2.5 py-0.5 text-[10px] font-medium text-accent/70 transition-colors hover:bg-[var(--accent-tint-hover)] hover:text-accent"
          >
            Cancel
          </button>
        )}
      </div>

      <div className="px-4 py-3 flex flex-col gap-3">
        {/* Countdown display */}
        {isActive && (
          <div
            className="flex items-center justify-center rounded-lg border border-accent/20 py-2 text-lg font-bold tabular-nums text-accent"
            style={{ background: "var(--accent-tint-subtle)" }}
          >
            {endOfTrack ? "End of Track" : formatRemaining(endsAt!)}
          </div>
        )}

        {/* Preset grid */}
        <div className="grid grid-cols-2 gap-1.5">
          {PRESETS.map(({ label, value }) => {
            const selected = isPresetSelected(value)
            return (
              <button
                key={value}
                onClick={() => handlePreset(value)}
                className={`rounded-lg border px-3 py-2.5 text-left text-xs font-medium transition-all ${
                  selected
                    ? "border-accent/50 text-accent"
                    : "border-[var(--border)] text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]"
                }`}
                style={{
                  background: selected ? "var(--accent-tint-strong)" : "var(--accent-tint-subtle)",
                  ...(selected ? { boxShadow: "0 0 8px rgb(var(--accent-rgb) / 0.15)" } : {}),
                }}
              >
                {label}
              </button>
            )
          })}
          {/* End of track */}
          <button
            onClick={() => { startEndOfTrack(); onClose() }}
            className={`col-span-2 rounded-lg border px-3 py-2.5 text-left text-xs font-medium transition-all ${
              endOfTrack
                ? "border-accent/50 text-accent"
                : "border-[var(--border)] text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]"
            }`}
            style={{
              background: endOfTrack ? "var(--accent-tint-strong)" : "var(--accent-tint-subtle)",
              ...(endOfTrack ? { boxShadow: "0 0 8px rgb(var(--accent-rgb) / 0.15)" } : {}),
            }}
          >
            End of track
          </button>
        </div>

        {/* Custom duration input */}
        <div className="border-t border-[var(--border)] pt-3">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[color:var(--text-muted)]">
            Custom
          </p>
          <div className="flex gap-1.5">
            <input
              type="number"
              min={1}
              max={480}
              placeholder="Minutes"
              value={customMinutes}
              onChange={e => setCustomMinutes(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleCustom() }}
              className="h-9 w-full rounded-lg border border-[var(--border)] px-3 text-xs text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)]/50 focus:border-accent/30 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              style={{ background: "var(--accent-tint-subtle)" }}
            />
            <button
              onClick={handleCustom}
              className="shrink-0 rounded-lg border border-[var(--border)] px-4 text-xs font-medium text-[color:var(--text-muted)] transition-all hover:text-[color:var(--text-secondary)]"
              style={{ background: "var(--accent-tint-subtle)" }}
            >
              Set
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
