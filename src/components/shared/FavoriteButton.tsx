import { useState } from "react"
import { IconHeart, IconHeartFilled } from "@tabler/icons-react"
import { useFavoritesStore } from "../../stores/favoritesStore"
import { useProviderStore } from "../../stores/providerStore"
import type { MusicTrack } from "../../types/music"
export function FavoriteButton({
  track,
  size = 16,
  className = "",
}: {
  track: MusicTrack
  size?: number
  className?: string
}) {
  const provider = useProviderStore((state) => state.provider)
  const liked = useFavoritesStore(
    (state) =>
      state.provider === provider &&
      state.session === provider?.playbackSession &&
      state.likedTrackIds.has(track.id)
  )
  const ready = useFavoritesStore(
    (state) =>
      state.loaded &&
      state.provider === provider &&
      state.session === provider?.playbackSession
  )
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null)
  if (
    !provider?.favorites ||
    !/^[1-9]\d*$/.test(track.id) ||
    !Number.isSafeInteger(Number(track.id))
  )
    return null
  return (
    <button
      type="button"
      aria-label={liked ? `Unlike ${track.title}` : `Like ${track.title}`}
      aria-pressed={liked}
      title={
        error ??
        (liked ? "Remove from Liked Songs" : "Save to Liked Songs in Hibiki")
      }
      disabled={saving || !ready}
      className={`inline-flex shrink-0 items-center justify-center rounded p-1 transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 ${liked ? "text-accent" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"} ${className}`}
      onClick={(event) => {
        event.stopPropagation()
        if (useProviderStore.getState().provider !== provider) return
        setSaving(true)
        setError(null)
        void useFavoritesStore
          .getState()
          .toggle(track, !liked)
          .catch(() =>
            setError("Could not save this like. Open Liked Songs to retry.")
          )
          .finally(() => setSaving(false))
      }}
    >
      {liked ? <IconHeartFilled size={size} /> : <IconHeart size={size} />}
    </button>
  )
}
