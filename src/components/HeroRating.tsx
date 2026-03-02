import { useState } from "react"
import { rateItem } from "../lib/plex"

interface HeroRatingProps {
  ratingKey: number
  userRating: number | null | undefined
}

export function HeroRating({ ratingKey, userRating }: HeroRatingProps) {
  const [local, setLocal] = useState<number | null | undefined>(undefined)
  const [hovered, setHovered] = useState<number | null>(null)
  const display = local !== undefined ? local : (userRating ?? null)
  const filled = Math.round((display ?? 0) / 2)
  const activeFilled = hovered !== null ? hovered : filled

  function rate(star: number) {
    const value = filled === star ? null : star * 2
    setLocal(value)
    void rateItem(ratingKey, value).catch(() => setLocal(undefined))
  }

  function clear() {
    setLocal(null)
    void rateItem(ratingKey, null).catch(() => setLocal(undefined))
  }

  return (
    <div className="flex items-center gap-0.5" onMouseLeave={() => setHovered(null)}>
      {/* Invisible clear zone to the left — hovering previews 0 stars, clicking clears */}
      <button
        title="Clear rating"
        aria-label="Clear rating"
        onClick={e => { e.stopPropagation(); clear() }}
        onMouseEnter={() => setHovered(0)}
        className="opacity-0 w-3.5 h-[15px]"
      />
      {[1, 2, 3, 4, 5].map(star => (
        <button
          key={star}
          title={`${star} star${star > 1 ? "s" : ""}`}
          onClick={e => { e.stopPropagation(); rate(star) }}
          onMouseEnter={() => setHovered(star)}
          className={`transition-colors ${activeFilled >= star ? "text-accent" : "text-white/25"}`}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor">
            <path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z" />
          </svg>
        </button>
      ))}
    </div>
  )
}
