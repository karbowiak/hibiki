import { IconPhoto, IconPlayerPause, IconPlayerPlay } from "@tabler/icons-react"
import { useAmbientArtworkControls } from "../lib/ambientArtworkContext"
export function AmbientArtworkControls() {
  const { visible, paused, next, togglePaused } = useAmbientArtworkControls()
  if (!visible) return null
  return (
    <div
      role="group"
      aria-label="Background artwork"
      className="flex items-center gap-1"
    >
      <button
        type="button"
        onClick={togglePaused}
        aria-label={
          paused ? "Resume background rotation" : "Pause background rotation"
        }
        aria-pressed={!paused}
        title={
          paused
            ? "Resume background rotation (every 45 seconds)"
            : "Pause background rotation"
        }
        className="shell-control-secondary flex h-8 w-8 items-center justify-center rounded-full"
      >
        {paused ? (
          <IconPlayerPlay size={14} aria-hidden="true" />
        ) : (
          <IconPlayerPause size={14} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        onClick={next}
        aria-label="Next background image"
        title="Next background image"
        className="shell-control-secondary flex h-8 w-8 items-center justify-center rounded-full"
      >
        <IconPhoto size={16} aria-hidden="true" />
      </button>
    </div>
  )
}
