import { Button } from "./Button"
import { useEffect, useState } from "react"
import { useItemRating } from "../../hooks/useItemRating"
import type { MusicTrack } from "../../types/music"
import { isYoutubeMusicId } from "../../backends/ytmusic/tracks"

interface StarRatingProps {
  itemId: string
  itemType?: "track" | "album" | "artist"
  userRating: number | null
  artist: string
  track: string
  size?: number
  enableLove?: boolean
  onRated?: () => void
  musicTrack?: MusicTrack
  variant?: "row" | "hero"
  onHero?: boolean
  eagerLike?: boolean
}

export function StarRating({
  itemId,
  itemType = "track",
  userRating,
  artist,
  track,
  size = 12,
  onRated,
  musicTrack,
  variant = "row",
  onHero = false,
  eagerLike: _eagerLike = false,
}: StarRatingProps) {
  const rating = useItemRating({
    itemId,
    itemType,
    userRating,
    artist,
    title: track,
    track: musicTrack,
  })
  const [hovered, setHovered] = useState<number | null>(null)
  useEffect(() => setHovered(null), [itemId, itemType])
  const filled = Math.round((rating.display ?? 0) / 2)
  const youtube = isYoutubeMusicId(itemId)
  const likeThreshold = youtube ? 2 : 3
  const likeLabel = youtube ? "liked on YouTube Music" : "liked"
  const visual = hovered ?? filled
  const inMenu = !!onRated
  if (!rating.available) return null
  const save = (value: number | null) => {
    void rating.rate(value).then((saved) => {
      if (saved) onRated?.()
    })
  }
  const selectedClass =
    variant === "hero" ? "text-accent" : "text-amber-600 dark:text-amber-400"
  const emptyClass =
    variant === "hero"
      ? onHero
        ? "text-white/40"
        : "text-(--text-muted)"
      : "text-amber-800/30 dark:text-gray-600"
  return (
    <div
      className={`group/rating flex shrink-0 items-center gap-0.5 ${inMenu ? "flex-wrap px-3 py-2" : ""}`}
      role="group"
      aria-label={`Rating for ${track || itemType}: ${filled} of 5 stars${itemType === "track" && filled >= likeThreshold ? `, ${likeLabel}` : ""}`}
      aria-description={rating.error ?? rating.hint}
      aria-busy={rating.saving}
      title={rating.error ?? rating.hint}
      onClick={(event) => event.stopPropagation()}
      onMouseLeave={() => setHovered(null)}
      onKeyDown={(event) => {
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault()
          event.stopPropagation()
          save(null)
        }
      }}
    >
      {inMenu && (
        <span className="mr-1 w-10 text-xs text-(--text-secondary)">
          Rating
        </span>
      )}
      {variant === "hero" && !inMenu && (
        <Button
          variant="bare"
          type="button"
          aria-label="Clear rating"
          title="Clear rating"
          disabled={rating.saving || !rating.enabled}
          onClick={(event) => {
            event.stopPropagation()
            save(null)
          }}
          onMouseEnter={() => setHovered(0)}
          className="flex h-[15px] w-3.5 items-center justify-center rounded-sm text-(--text-secondary) opacity-0 group-hover/rating:opacity-70 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-30"
        >
          <span aria-hidden="true">×</span>
        </Button>
      )}
      {[1, 2, 3, 4, 5].map((star) => (
        <Button
          variant="bare"
          key={star}
          type="button"
          disabled={rating.saving || !rating.enabled}
          aria-label={`${star} star${star > 1 ? "s" : ""}`}
          aria-pressed={filled === star}
          title={
            filled === star
              ? "Clear rating"
              : `Rate ${star} star${star > 1 ? "s" : ""}${itemType === "track" ? (star >= likeThreshold ? ` · ${likeLabel}` : ` · not ${likeLabel}`) : ""}`
          }
          className={`rounded-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait ${visual >= star ? selectedClass : emptyClass}`}
          onMouseEnter={() => setHovered(star)}
          onFocus={() => setHovered(star)}
          onBlur={() => setHovered(null)}
          onClick={(event) => {
            event.stopPropagation()
            save(filled === star ? null : star * 2)
          }}
        >
          <svg
            viewBox="0 0 16 16"
            width={size}
            height={size}
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z" />
          </svg>
        </Button>
      ))}
      {inMenu && filled > 0 && (
        <Button
          variant="secondary"
          type="button"
          title="Clear rating"
          aria-label="Clear rating"
          disabled={rating.saving || !rating.enabled}
          className="ml-1 rounded-sm px-1 text-xs text-(--text-secondary) hover:text-(--text-primary) focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          onClick={(event) => {
            event.stopPropagation()
            save(null)
          }}
        >
          ×
        </Button>
      )}
      {inMenu && rating.error && (
        <p
          className="mt-1 w-full text-xs text-(--text-secondary)"
          role="status"
        >
          {rating.error}
        </p>
      )}
    </div>
  )
}
