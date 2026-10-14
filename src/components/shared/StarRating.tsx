import { useEffect, useRef, useState } from "react"
import { useFavoritesStore } from "../../stores/favoritesStore"
import { useLibraryStore } from "../../stores/libraryStore"
import { useProviderStore } from "../../stores/providerStore"
import { useProviderMutationOwner } from "../../hooks/useProviderMutationOwner"
import { useCapability } from "../../hooks/useCapability"

interface StarRatingProps {
  itemId: string
  itemType?: "track" | "album" | "artist"
  userRating: number | null
  artist: string
  track: string
  size?: number         // default 12; Liked uses 12, Playlist uses 11
  enableLove?: boolean  // default true; pass false for non-track items
  onRated?: () => void  // called after rating; ContextMenu uses to close menu
}

export function StarRating({ itemId, itemType = "track", userRating, artist, track, size = 12, enableLove = true, onRated }: StarRatingProps) {
  const hasRatings = useCapability("ratings")
  const provider = useProviderStore(s => s.provider)
  const captureOwner = useProviderMutationOwner(provider)
  const request = useRef(0)
  const pending = useRef(false)
  const [saving, setSaving] = useState(false)
  const [local, setLocal] = useState<number | null | undefined>(undefined)
  const [hoverStar, setHoverStar] = useState(0)
  const display = local !== undefined ? local : userRating
  const filled = Math.round((display ?? 0) / 2)

  useEffect(() => { ++request.current; pending.current = false; setSaving(false); setLocal(undefined); setHoverStar(0) }, [provider, itemId, itemType])

  const inMenu = !!onRated

  function rate(value: number | null) {
    if (pending.current) return
    const owned = captureOwner(), sequence = ++request.current
    const current = () => owned() && sequence === request.current
    if (!provider || !current()) return
    pending.current = true
    setSaving(true)
    setLocal(value)
    void provider.rate(itemId, value).then(() => {
      if (!current()) return
      useLibraryStore.getState().onItemRated(itemId, itemType, value)
      if (enableLove && artist && track) {
        void useFavoritesStore.getState().ratingChanged(itemId,track,artist,value).catch(() => {})
      }
      onRated?.()
    }).catch(() => {
      if (!current()) return
      setLocal(undefined)
      useLibraryStore.setState({ error: "Unable to save the rating. Please try again." })
    }).finally(() => {
      if (sequence === request.current) { pending.current = false; if (owned()) setSaving(false) }
    })
  }

  if (!hasRatings) return null

  // When hovering, show the hovered level; otherwise show the persisted rating
  const visual = hoverStar > 0 ? hoverStar : filled

  return (
    <div
      className={`flex items-center ${inMenu ? "gap-1 px-3 py-2" : "gap-0.5"}`}
      aria-busy={saving}
      onClick={e => e.stopPropagation()}
      onMouseLeave={() => setHoverStar(0)}
    >
      {inMenu && <span className="text-xs text-white/40 mr-1 w-10">Rating</span>}
      {[1, 2, 3, 4, 5].map(star => (
        <button
          key={star}
          disabled={saving}
          title={`${inMenu ? "" : "Rate "}${star} star${star > 1 ? "s" : ""}`}
          className={`transition-colors ${
            visual >= star
              ? hoverStar > 0 ? "text-amber-600/70 dark:text-amber-400/70" : "text-amber-600 dark:text-amber-400"
              : inMenu ? "text-white/30 hover:text-amber-600/70 dark:hover:text-amber-400/70" : "text-amber-800/30 dark:text-gray-600 hover:text-amber-600/70 dark:hover:text-amber-400/70"
          }`}
          onMouseEnter={() => setHoverStar(star)}
          onClick={e => {
            e.stopPropagation()
            rate(filled === star ? null : star * 2)
          }}
        >
          <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor">
            <path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z" />
          </svg>
        </button>
      ))}
      {inMenu && filled > 0 && (
        <button
          title="Clear rating"
          disabled={saving}
          onClick={e => { e.stopPropagation(); rate(null) }}
          className="ml-1 text-white/25 hover:text-white/60 text-xs"
        >✕</button>
      )}
    </div>
  )
}
