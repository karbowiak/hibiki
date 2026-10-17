import { useEffect } from "react"
import type { MusicTrack } from "../../types/music"
import { isYoutubeMusicId } from "../../backends/ytmusic/tracks"
import { useYoutubeMusicLikesStore } from "../../backends/ytmusic/likes"
import { StarRating } from "./StarRating"

/** Kept as a compatibility export; every former YTM heart now uses shared stars. */
export function YoutubeMusicLikeButton({ track, eager = false, size = 12, onSaved }: {
  track: MusicTrack; eager?: boolean; size?: number; onSaved?: () => void
}) {
  const owner = useYoutubeMusicLikesStore(state => state.owner)
  useEffect(() => {
    if (eager && owner !== null && isYoutubeMusicId(track.id)) void useYoutubeMusicLikesStore.getState().check(track)
  }, [track.id, owner, eager])
  if (!isYoutubeMusicId(track.id)) return null
  return <span onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <StarRating itemId={track.id} userRating={track.userRating} musicTrack={track} artist={track.artistName} track={track.title}
      size={Math.min(size, 12)} onRated={onSaved} />
  </span>
}
