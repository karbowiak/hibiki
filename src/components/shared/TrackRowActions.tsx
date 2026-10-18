import { Button } from "./Button"
import type { MusicTrack } from "../../types/music"
import { isYoutubeMusicTrack } from "../../backends/ytmusic/tracks"
import { YoutubeMusicLikeButton } from "./YoutubeMusicLikeButton"
import { useYoutubeMusicDiscoveryStore } from "../../backends/ytmusic/discovery"
import { usePlayerStore } from "../../stores/playerStore"

interface Props {
  track: MusicTrack
  unavailable: boolean
  showRadio: boolean
  showLike?: boolean
  onAddToQueue: (tracks: MusicTrack[]) => void
  onPlayRadio: (id: string, type: "track") => void
}

/** Shared inline actions: same order and placement as the original playlist row. */
export function TrackRowActions({
  track,
  unavailable,
  showRadio,
  showLike = true,
  onAddToQueue,
  onPlayRadio,
}: Props) {
  const youtubeConnected = useYoutubeMusicDiscoveryStore(s => s.connected)
  const youtube = isYoutubeMusicTrack(track)
  return (
    <div
      className="track-row-actions"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {showLike && <YoutubeMusicLikeButton track={track} size={14} />}
      <Button
        variant="bare"
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
      </Button>
      {(youtube ? youtubeConnected : showRadio) && (
        <Button
          variant="bare"
          type="button"
          disabled={unavailable}
          aria-label={`Start radio for ${track.title}`}
          title={youtube ? "YTM radio" : "Plex radio"}
          onClick={(event) => {
            event.stopPropagation()
            if (youtube) void usePlayerStore.getState().playRadio(track.id, "track", track.title, "ytmusic", track)
            else void onPlayRadio(track.id, "track")
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
        </Button>
      )}
    </div>
  )
}
