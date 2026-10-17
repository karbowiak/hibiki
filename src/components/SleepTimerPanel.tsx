import { useEffect, useId, useState } from "react"
import { useSleepTimerStore } from "../stores/sleepTimerStore"
import { PlayerPanelHeader } from "./shared/PlayerPanelHeader"

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
  const durationId = useId()
  const minutes = Number(customMinutes)
  const validDuration = Number.isInteger(minutes) && minutes >= 1 && minutes <= 480
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
    if (!validDuration) return
    start(minutes)
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
      <PlayerPanelHeader title="Sleep Timer" onClose={onClose} actions={isActive ? (
          <button
            onClick={() => { cancel(); onClose() }}
            className="player-panel-action"
          >
            Cancel timer
          </button>
        ) : undefined} />

      <div className="px-4 py-3 flex flex-col gap-3">
        {/* Countdown display */}
        {isActive && (
          <div
            className="player-panel-duration"
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
                aria-pressed={selected}
                className="player-panel-option"
              >
                {label}
              </button>
            )
          })}
          {/* End of track */}
          <button
            onClick={() => { startEndOfTrack(); onClose() }}
            aria-pressed={endOfTrack}
            className="player-panel-option col-span-2"
          >
            End of track
          </button>
        </div>

        {/* Custom duration input */}
        <div className="border-t border-(--border) pt-3">
          <label htmlFor={durationId} className="mb-2 block text-xs font-medium text-(--text-secondary)">Custom duration</label>
          <div className="flex gap-1.5">
            <input
              id={durationId}
              aria-label="Sleep timer duration in minutes"
              type="number"
              min={1}
              max={480}
              step={1}
              placeholder="Minutes"
              value={customMinutes}
              onChange={e => setCustomMinutes(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleCustom() }}
              className="app-input w-full [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <button
              onClick={handleCustom}
              disabled={!validDuration}
              className="player-panel-option shrink-0 disabled:cursor-default disabled:opacity-40"
            >
              Set
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
