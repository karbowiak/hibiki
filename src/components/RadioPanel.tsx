import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores"

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
      <div className="px-5 py-4 border-b border-[var(--border)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[0.625rem] font-bold uppercase tracking-widest text-[color:var(--text-muted)]">
                Radio
              </span>
              {typeLabel && (
                <span className="text-[0.625rem] font-bold uppercase tracking-wider rounded-full bg-accent/15 border border-accent/30 px-2 py-0.5 text-accent">
                  {typeLabel}
                </span>
              )}
            </div>
            <p className="text-sm font-semibold text-[color:var(--text-primary)] truncate">
              {radioSeedArtist ? `${radioSeedArtist} — ${seedName}` : seedName}
            </p>
          </div>
          <button
            onClick={() => { stopRadio(); onClose() }}
            className="flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full bg-[var(--bg-surface)] text-[color:var(--text-muted)] hover:bg-red-500/20 hover:text-red-400 transition-colors"
          >
            Stop
          </button>
        </div>
      </div>

      {/* Variety */}
      <div className="px-5 py-4 border-b border-[var(--border)]">
        <p className="text-[0.625rem] font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-3">
          Variety
        </p>
        <div className="grid grid-cols-3 gap-1.5 mb-3">
          {VARIETY_OPTIONS.map(opt => {
            const selected = radioDegreesOfSeparation === opt.value
            return (
              <button
                key={opt.value}
                onClick={() => setRadioDegreesOfSeparation(opt.value)}
                title={opt.desc}
                className={`rounded-lg border py-2 text-xs font-semibold transition-all ${
                  selected
                    ? "border-accent/50 text-accent"
                    : "border-[var(--border)] text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]"
                }`}
                style={{
                  background: selected ? "var(--accent-tint-strong)" : "var(--accent-tint-subtle)",
                  ...(selected ? { boxShadow: "0 0 8px rgb(var(--accent-rgb) / 0.15)" } : {}),
                }}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
        {activeVariety && (
          <p className="text-[0.6875rem] text-[color:var(--text-muted)] leading-snug">{activeVariety.desc}</p>
        )}
      </div>

      {/* Queue buffer */}
      <div className="px-5 py-4">
        <p className="text-[0.625rem] font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-3">
          Queue Buffer
        </p>
        <div className="flex items-center justify-between">
          <span className="text-[0.6875rem] text-[color:var(--text-secondary)]">Always keep ahead</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setRadioMinQueue(Math.max(MIN_QUEUE, radioMinQueue - 1))}
              disabled={radioMinQueue <= MIN_QUEUE}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] hover:text-[color:var(--text-primary)] transition-colors disabled:opacity-30 disabled:cursor-default font-bold text-base leading-none"
            >
              −
            </button>
            <span className="w-8 text-center text-sm font-semibold text-[color:var(--text-primary)] tabular-nums">
              {radioMinQueue}
            </span>
            <button
              onClick={() => setRadioMinQueue(Math.min(MAX_QUEUE, radioMinQueue + 1))}
              disabled={radioMinQueue >= MAX_QUEUE}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] hover:text-[color:var(--text-primary)] transition-colors disabled:opacity-30 disabled:cursor-default font-bold text-base leading-none"
            >
              +
            </button>
            <span className="text-[0.6875rem] text-[color:var(--text-secondary)]">tracks</span>
          </div>
        </div>
      </div>
    </>
  )
}
