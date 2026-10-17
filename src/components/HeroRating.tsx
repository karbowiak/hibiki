import { StarRating } from "./shared/StarRating"
import type { MusicTrack } from "../types/music"
interface HeroRatingProps {
  itemId: string
  userRating: number | null | undefined
  itemType?: "album" | "artist" | "track"
  onHero?: boolean
  musicTrack?: MusicTrack
}
/** Hero and table presentations share the same rating state, writes and keyboard behavior. */
export function HeroRating({
  itemId,
  userRating,
  itemType = "track",
  onHero = false,
  musicTrack,
}: HeroRatingProps) {
  return (
    <StarRating
      itemId={itemId}
      userRating={userRating ?? null}
      itemType={itemType}
      onHero={onHero}
      musicTrack={musicTrack}
      artist={musicTrack?.artistName ?? ""}
      track={musicTrack?.title ?? itemType}
      size={15}
      variant="hero"
    />
  )
}
