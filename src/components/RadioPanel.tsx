import { Button } from "./shared/Button"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores"
import { PlayerPanelHeader } from "./shared/PlayerPanelHeader"
import { MusicSourceBadge } from "./shared/MusicSource"

const VARIETY_OPTIONS = [
  { label: "Focused",      value: 0,  desc: "Very similar to your seed" },
  { label: "Similar",      value: 1,  desc: "Closely related tracks" },
  { label: "Balanced",     value: 2,  desc: "A good mix of familiar and new" },
  { label: "Diverse",      value: 3,  desc: "Wider range of suggestions" },
  { label: "Adventurous",  value: 4,  desc: "Anything loosely connected" },
  { label: "Wild",         value: -1, desc: "Completely unrestricted" },
]

interface Props {
  onClose: () => void
}

export default function RadioPanel({ onClose }: Props) {
  const {
    contextName,
    radioType,
    radioSeedArtist,
    radioDegreesOfSeparation,
    radioMode,
    setRadioDegreesOfSeparation,
    stopRadio,
  } = usePlayerStore(
    useShallow(s => ({
      contextName:                s.contextName,
      radioType:                  s.radioType,
      radioSeedArtist:            s.radioSeedArtist,
      radioDegreesOfSeparation:   s.radioDegreesOfSeparation,
      radioMode:                  s.radioMode,
      setRadioDegreesOfSeparation: s.setRadioDegreesOfSeparation,
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
          <Button
            variant="bare"
            onClick={() => { stopRadio(); onClose() }}
            className="player-panel-action"
          >
            Stop
          </Button>
        } />

      {/* Variety */}
      {radioMode !== "ytmusic" && <div className="px-5 py-4 border-b border-(--border)">
        <p className="text-[0.625rem] font-semibold uppercase tracking-widest text-(--text-muted) mb-3">
          Plex variety
        </p>
        <div className="grid grid-cols-3 gap-1.5 mb-3">
          {VARIETY_OPTIONS.map(opt => {
            const selected = radioDegreesOfSeparation === opt.value
            return (
              <Button
                variant="bare"
                key={opt.value}
                onClick={() => setRadioDegreesOfSeparation(opt.value)}
                aria-pressed={selected}
                title={opt.desc}
                className="player-panel-option !px-2 !text-xs"
              >
                {opt.label}
              </Button>
            )
          })}
        </div>
        {activeVariety && (
          <p className="text-[0.6875rem] text-(--text-muted) leading-snug">{activeVariety.desc}</p>
        )}
      </div>}

      <div className="px-5 py-4">
        <div className="mb-2 flex items-center gap-3 text-sm font-medium">
          {radioMode !== "ytmusic" && <MusicSourceBadge source="plex" label />}
          {radioMode !== "plex" && <MusicSourceBadge source="ytmusic" label />}
        </div>
        <p className="text-xs text-(--text-secondary)">
          {radioMode === "mixed" ? "10 songs ahead: 5 Plex + 5 YTM, alternating." : "10 songs ahead, topped up as you listen."}
        </p>
      </div>
    </>
  )
}
