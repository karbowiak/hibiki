import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores"
import { PlayerPanelHeader } from "./shared/PlayerPanelHeader"
import { IconMinus, IconPlus } from "@tabler/icons-react"

const VARIETY_OPTIONS = [
  { label: "Focused",      value: 0,  desc: "Very similar to your seed" },
  { label: "Similar",      value: 1,  desc: "Closely related tracks" },
  { label: "Balanced",     value: 2,  desc: "A good mix of familiar and new" },
  { label: "Diverse",      value: 3,  desc: "Wider range of suggestions" },
  { label: "Adventurous",  value: 4,  desc: "Anything loosely connected" },
  { label: "Wild",         value: -1, desc: "Completely unrestricted" },
]

const MIN_QUEUE = 3
const MAX_QUEUE = 20

interface Props {
  onClose: () => void
}

export default function RadioPanel({ onClose }: Props) {
  const {
    contextName,
    radioType,
    radioSeedArtist,
    radioDegreesOfSeparation,
    radioMinQueue,
    setRadioDegreesOfSeparation,
    setRadioMinQueue,
    stopRadio,
  } = usePlayerStore(
    useShallow(s => ({
      contextName:                s.contextName,
      radioType:                  s.radioType,
      radioSeedArtist:            s.radioSeedArtist,
      radioDegreesOfSeparation:   s.radioDegreesOfSeparation,
      radioMinQueue:              s.radioMinQueue,
      setRadioDegreesOfSeparation: s.setRadioDegreesOfSeparation,
      setRadioMinQueue:           s.setRadioMinQueue,
      stopRadio:                  s.stopRadio,
    })),
  )

  // Strip " Radio" suffix so we show just the seed name
  const seedName = contextName?.replace(/ Radio$/, "") ?? "Unknown"
  const typeLabel = radioType
    ? radioType.charAt(0).toUpperCase() + radioType.slice(1)
    : null

  const activeVariety = VARIETY_OPTIONS.find(o => o.value === radioDegreesOfSeparation)

  return (
    <>
      {/* Header — seed name + type + stop button */}
      <PlayerPanelHeader title="Radio" onClose={onClose}
        subtitle={`${radioSeedArtist ? `${radioSeedArtist} — ${seedName}` : seedName}${typeLabel ? ` · ${typeLabel}` : ""}`}
        actions={
          <button
            onClick={() => { stopRadio(); onClose() }}
            className="player-panel-action"
          >
            Stop
          </button>
        } />

      {/* Variety */}
      <div className="px-5 py-4 border-b border-(--border)">
        <p className="text-[0.625rem] font-semibold uppercase tracking-widest text-(--text-muted) mb-3">
          Variety
        </p>
        <div className="grid grid-cols-3 gap-1.5 mb-3">
          {VARIETY_OPTIONS.map(opt => {
            const selected = radioDegreesOfSeparation === opt.value
            return (
              <button
                key={opt.value}
                onClick={() => setRadioDegreesOfSeparation(opt.value)}
                aria-pressed={selected}
                title={opt.desc}
                className="player-panel-option !px-2 !text-xs"
              >
                {opt.label}
              </button>
            )
          })}
        </div>
        {activeVariety && (
          <p className="text-[0.6875rem] text-(--text-muted) leading-snug">{activeVariety.desc}</p>
        )}
      </div>

      {/* Queue buffer */}
      <div className="px-5 py-4">
        <p className="text-[0.625rem] font-semibold uppercase tracking-widest text-(--text-muted) mb-3">
          Queue Buffer
        </p>
        <div className="flex items-center justify-between">
          <span className="text-[0.6875rem] text-(--text-secondary)">Always keep ahead</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setRadioMinQueue(Math.max(MIN_QUEUE, radioMinQueue - 1))}
              aria-label="Fewer queued radio tracks"
              disabled={radioMinQueue <= MIN_QUEUE}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-(--bg-surface) text-(--text-secondary) hover:bg-(--bg-surface-hover) hover:text-(--text-primary) transition-colors disabled:opacity-30 disabled:cursor-default font-bold text-base leading-none"
            >
              <IconMinus size={16} aria-hidden="true" />
            </button>
            <span className="w-8 text-center text-sm font-semibold text-(--text-primary) tabular-nums">
              {radioMinQueue}
            </span>
            <button
              onClick={() => setRadioMinQueue(Math.min(MAX_QUEUE, radioMinQueue + 1))}
              aria-label="More queued radio tracks"
              disabled={radioMinQueue >= MAX_QUEUE}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-(--bg-surface) text-(--text-secondary) hover:bg-(--bg-surface-hover) hover:text-(--text-primary) transition-colors disabled:opacity-30 disabled:cursor-default font-bold text-base leading-none"
            >
              <IconPlus size={16} aria-hidden="true" />
            </button>
            <span className="text-[0.6875rem] text-(--text-secondary)">tracks</span>
          </div>
        </div>
      </div>
    </>
  )
}
