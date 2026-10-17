import type { MusicTrack } from "../../types/music"

interface Props {
  track: MusicTrack
  unavailable: boolean
  showRadio: boolean
  onAddToQueue: (tracks: MusicTrack[]) => void
  onPlayRadio: (id: string, type: "track") => void
}

/** Shared inline actions: same order and placement as the original playlist row. */
export function TrackRowActions({
  track,
  unavailable,
  showRadio,
  onAddToQueue,
  onPlayRadio,
}: Props) {
  return (
    <div
      className="track-row-actions"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        disabled={unavailable}
        aria-label={`Add ${track.title} to queue`}
        title={unavailable ? "Not available offline" : "Add to Queue"}
        onClick={(event) => {
          event.stopPropagation()
          onAddToQueue([track])
        }}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="10"
          height="10"
          fill="currentColor"
        >
          <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z" />
        </svg>
        Queue
      </button>
      {showRadio && (
        <button
          type="button"
          disabled={unavailable}
          aria-label={`Start radio for ${track.title}`}
          title="Track Radio"
          onClick={(event) => {
            event.stopPropagation()
            void onPlayRadio(track.id, "track")
          }}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="10"
            height="10"
            fill="currentColor"
          >
            <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
          </svg>
          Radio
        </button>
      )}
    </div>
  )
}
