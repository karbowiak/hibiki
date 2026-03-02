import { useEffect, useRef, useState } from "react"
import { useSleepTimerStore } from "../stores/sleepTimerStore"

const PRESETS = [15, 30, 45, 60, 90]

function formatRemaining(endsAt: number): string {
  const ms = Math.max(0, endsAt - Date.now())
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, "0")}`
}

export default function SleepTimerPanel() {
  const { endsAt, start, cancel } = useSleepTimerStore()
  const panelRef = useRef<HTMLDivElement>(null)
  const [, forceUpdate] = useState(0)

  // Tick every second to update countdown
  useEffect(() => {
    if (!endsAt) return
    const id = setInterval(() => forceUpdate(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [endsAt])

  // Close on outside click
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        // Dispatch a custom event so the parent button can close us
        document.dispatchEvent(new CustomEvent("sleep-timer-outside-click"))
      }
    }
    document.addEventListener("mousedown", onMouseDown)
    return () => document.removeEventListener("mousedown", onMouseDown)
  }, [])

  return (
    <div
      ref={panelRef}
      className="absolute bottom-full right-0 mb-2 z-50 w-56 rounded-xl bg-app-card border border-[var(--border)] shadow-2xl select-none"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--border)]">
        <span className="text-sm font-semibold text-white tracking-wide">Sleep Timer</span>
      </div>

      {endsAt ? (
        /* Active state — show countdown + cancel */
        <div className="px-4 py-4 flex flex-col items-center gap-3">
          <div className="text-2xl font-mono font-semibold text-accent">
            {formatRemaining(endsAt)}
          </div>
          <p className="text-xs text-white/50 text-center">Pausing after timer ends</p>
          <button
            onClick={cancel}
            className="w-full rounded-full bg-white/10 py-1.5 text-sm text-white/70 hover:bg-white/20 hover:text-white transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        /* Inactive state — preset pills */
        <div className="px-4 py-3 flex flex-wrap gap-2">
          {PRESETS.map(min => (
            <button
              key={min}
              onClick={() => start(min)}
              className="rounded-full bg-white/10 px-3 py-1 text-sm text-white/70 hover:bg-white/20 hover:text-white transition-colors"
            >
              {min} min
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
