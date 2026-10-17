import { useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores/playerStore"
import { useVisualizerStore } from "../stores/visualizerStore"
import { formatMs } from "../lib/formatters"
import VisualizerCanvas from "./VisualizerCanvas"

/** Frequent clock and pointer updates stay inside the seek controls. */
export function PlayerProgress() {
  const { currentTrack, waveformLevels, seekTo } = usePlayerStore(
    useShallow((state) => ({
      currentTrack: state.currentTrack,
      waveformLevels: state.waveformLevels,
      seekTo: state.seekTo,
    }))
  )
  const positionMs = usePlayerStore((state) => state.positionMs)
  const compactMode = useVisualizerStore((state) => state.compactMode)
  const [seekHoverPct, setSeekHoverPct] = useState<number | null>(null)
  const progressPct = currentTrack?.duration
    ? (positionMs / currentTrack.duration) * 100
    : 0
  // Fixed clock width keeps waveform geometry stable as the time changes.
  const timeColumnWidth = `${Math.max(5, formatMs(currentTrack?.duration ?? 0).length)}ch`
  return (
    <div className="pointer-events-auto mt-1.5 flex w-full items-center gap-x-2">
      <div
        className="text-opacity-70 shrink-0 text-right text-[0.688rem] whitespace-nowrap text-white tabular-nums"
        style={{ width: timeColumnWidth }}
      >
        {formatMs(
          seekHoverPct !== null
            ? ((currentTrack?.duration ?? 0) * seekHoverPct) / 100
            : positionMs
        )}
      </div>
      <div
        className={`relative h-7 min-w-0 flex-1 select-none ${currentTrack ? "cursor-pointer" : "cursor-default opacity-40"}`}
        onMouseMove={(e) => {
          if (!currentTrack) return
          const rect = e.currentTarget.getBoundingClientRect()
          setSeekHoverPct(
            Math.max(
              0,
              Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)
            )
          )
        }}
        onMouseLeave={() => setSeekHoverPct(null)}
        onClick={(e) => {
          if (!currentTrack) return
          const rect = e.currentTarget.getBoundingClientRect()
          const pct = Math.max(
            0,
            Math.min(1, (e.clientX - rect.left) / rect.width)
          )
          seekTo((currentTrack?.duration ?? 0) * pct)
        }}
      >
        <VisualizerCanvas
          progressPct={progressPct}
          hoverPct={seekHoverPct}
          levels={waveformLevels}
          mode={compactMode}
        />
        <input
          type="range"
          disabled={!currentTrack}
          min={0}
          max={currentTrack?.duration ?? 0}
          value={positionMs}
          onChange={(e) => seekTo(parseFloat(e.target.value))}
          className="absolute inset-0 h-full w-full opacity-0"
          aria-label="Seek"
        />
      </div>
      <div
        className="text-opacity-70 shrink-0 text-[0.688rem] whitespace-nowrap text-white tabular-nums"
        style={{ width: timeColumnWidth }}
      >
        {formatMs(currentTrack?.duration ?? 0)}
      </div>
    </div>
  )
}
