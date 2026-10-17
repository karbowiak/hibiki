import { useEffect, useRef, useState } from "react"
import { useFavoritesStore } from "../stores/favoritesStore"
import { useProviderStore } from "../stores/providerStore"
import { useLibraryStore } from "../stores/libraryStore"
import { useProviderMutationOwner } from "./useProviderMutationOwner"
import { useCapability } from "./useCapability"
import { effectiveTrackRating, trackRatingHint } from "../favorites/ratings"
import { saveTrackRatingToPlex } from "../favorites/saveRating"
import type { MusicTrack } from "../types/music"
import { isYoutubeMusicId } from "../backends/ytmusic/tracks"

/** Shared by every star control; artist and album ratings retain their Plex behavior. */
export function useItemRating({
  itemId,
  itemType,
  userRating,
  artist,
  title,
  track,
}: {
  itemId: string
  itemType: "track" | "album" | "artist"
  userRating: number | null | undefined
  artist: string
  title: string
  track?: MusicTrack
}) {
  const provider = useProviderStore((s) => s.provider)
  const session = provider?.playbackSession
  const scope = provider?.cacheScope
  const captureOwner = useProviderMutationOwner(provider)
  const hasRatings = useCapability("ratings")
  const independent = isYoutubeMusicId(itemId)
  const localTrack =
    itemType === "track" &&
    !!provider?.favorites &&
    /^[1-9]\d*$/.test(itemId) &&
    Number.isSafeInteger(Number(itemId))
  const favorite = useFavoritesStore((s) =>
    localTrack && s.provider === provider && s.session === session
      ? s.ratingsByTrackId.get(itemId)
      : undefined
  )
  const ready = useFavoritesStore(
    (s) =>
      !localTrack ||
      (s.loaded && s.provider === provider && s.session === session)
  )
  const [optimistic, setOptimistic] = useState<number | null | undefined>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0),
    pending = useRef(false)
  useEffect(() => {
    ++request.current
    pending.current = false
    setSaving(false)
    setOptimistic(undefined)
    setError(null)
  }, [provider, session, scope, itemId, itemType])
  const display = localTrack
    ? effectiveTrackRating(userRating, favorite)
    : optimistic === undefined
      ? userRating
      : optimistic
  const hint = localTrack ? trackRatingHint(userRating, favorite) : undefined
  const rate = async (value: number | null) => {
    if (independent || !provider || pending.current || !ready || (!hasRatings && !localTrack))
      return false
    const owned = captureOwner(),
      revision = ++request.current
    const current = () =>
      owned() &&
      provider.playbackSession === session &&
      provider.cacheScope === scope &&
      revision === request.current
    if (!current()) return false
    pending.current = true
    setSaving(true)
    setError(null)
    if (!localTrack) setOptimistic(value)
    try {
      if (localTrack) {
        const intent = await useFavoritesStore
          .getState()
          .ratingChanged(itemId, title, artist, value, track)
        await saveTrackRatingToPlex(provider, intent, session, scope)
      } else {
        await provider.rate(itemId, value)
        if (current())
          useLibraryStore.getState().onItemRated(itemId, itemType, value)
      }
      return current()
    } catch (failure) {
      if (current()) {
        setError(localTrack && failure instanceof Error ? failure.message : "Unable to save the rating. Please try again.")
        if (!localTrack) setOptimistic(undefined)
      }
      return false
    } finally {
      if (revision === request.current) {
        pending.current = false
        if (current()) setSaving(false)
      }
    }
  }
  return {
    display: display ?? null,
    saving,
    error,
    hint,
    rate,
    available: !independent && (hasRatings || localTrack),
    enabled: !independent && (hasRatings || localTrack) && ready,
  }
}
