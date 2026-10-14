import { useLayoutEffect, useRef, useState } from "react"
import { useLibraryStore } from "../stores/libraryStore"
import { useProviderStore } from "../stores/providerStore"
import { useProviderMutationOwner } from "../hooks/useProviderMutationOwner"
import { useCapability } from "../hooks/useCapability"
import { useFavoritesStore } from "../stores/favoritesStore"
import type { MusicTrack } from "../types/music"

interface HeroRatingProps {
  itemId: string
  userRating: number | null | undefined
  itemType?: "album" | "artist" | "track"
  onHero?: boolean
  musicTrack?: MusicTrack
}

export function HeroRating({
  itemId,
  userRating,
  itemType = "track",
  onHero = false,
  musicTrack,
}: HeroRatingProps) {
  const hasRatings = useCapability("ratings")
  const provider = useProviderStore((state) => state.provider)
  const scope = provider?.cacheScope
  const captureOwner = useProviderMutationOwner(provider)
  const request = useRef(0)
  const pending = useRef(false)
  const [saving, setSaving] = useState(false)
  const [local, setLocal] = useState<number | null | undefined>(undefined)
  const [hovered, setHovered] = useState<number | null>(null)
  const display = local !== undefined ? local : (userRating ?? null)
  const filled = Math.round((display ?? 0) / 2)
  const activeFilled = hovered !== null ? hovered : filled

  useLayoutEffect(() => {
    ++request.current
    pending.current = false
    setSaving(false)
    setLocal(undefined)
    setHovered(null)
  }, [itemId, itemType, provider, scope])

  function save(value: number | null) {
    if (pending.current || !provider || !hasRatings) return
    const owned = captureOwner(),
      sequence = ++request.current
    const current = () =>
      owned() && provider.cacheScope === scope && sequence === request.current
    if (!current()) return
    pending.current = true
    setSaving(true)
    setLocal(value)
    void Promise.resolve()
      .then(() => provider.rate(itemId, value))
      .then(() => {
        if (current() && itemType)
          useLibraryStore.getState().onItemRated(itemId, itemType, value)
        if (current() && itemType === "track" && musicTrack)
          void useFavoritesStore
            .getState()
            .ratingChanged(
              itemId,
              musicTrack.title,
              musicTrack.artistName,
              value
            )
            .catch(() => {})
      })
      .catch(() => {
        if (current()) setLocal(undefined)
      })
      .finally(() => {
        if (sequence !== request.current) return
        pending.current = false
        if (owned() && provider.cacheScope === scope) setSaving(false)
      })
  }

  if (!hasRatings) return null

  return (
    <div
      role="group"
      aria-label="Rating"
      aria-busy={saving}
      className="group/rating flex items-center gap-0.5"
      onMouseLeave={() => setHovered(null)}
    >
      {/* Clear remains quiet until hover or keyboard focus. */}
      <button
        type="button"
        disabled={saving}
        title="Clear rating"
        aria-label="Clear rating"
        onClick={(e) => {
          e.stopPropagation()
          save(null)
        }}
        onMouseEnter={() => setHovered(0)}
        className="flex h-[15px] w-3.5 items-center justify-center rounded-sm text-[color:var(--text-secondary)] opacity-0 group-hover/rating:opacity-70 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-30"
      >
        <span aria-hidden="true">×</span>
      </button>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          disabled={saving}
          aria-label={`${star} star${star > 1 ? "s" : ""}`}
          aria-pressed={filled === star}
          title={`${star} star${star > 1 ? "s" : ""}`}
          onClick={(e) => {
            e.stopPropagation()
            save(filled === star ? null : star * 2)
          }}
          onMouseEnter={() => setHovered(star)}
          className={`rounded-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait ${activeFilled >= star ? "text-accent" : onHero ? "text-white/40" : "text-[color:var(--text-muted)]"}`}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor">
            <path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z" />
          </svg>
        </button>
      ))}
    </div>
  )
}
