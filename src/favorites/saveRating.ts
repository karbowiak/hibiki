import type { MusicProvider } from "../providers/types"
import { useProviderStore } from "../stores/providerStore"
import { useFavoritesStore } from "../stores/favoritesStore"
import { useLibraryStore } from "../stores/libraryStore"
import { effectiveTrackRating, type FavoriteRatingIntent } from "./ratings"

const tails = new WeakMap<MusicProvider, Map<string, Promise<void>>>()

/** Only explicit star edits/retries enter this lane; imports never call it. */
export function saveTrackRatingToPlex(
  provider: MusicProvider,
  intent: FavoriteRatingIntent,
  session = provider.playbackSession,
  scope = provider.cacheScope
): Promise<void> {
  let lane = tails.get(provider)
  if (!lane) tails.set(provider, (lane = new Map()))
  const owned = () =>
    useProviderStore.getState().provider === provider &&
    provider.playbackSession === session &&
    provider.cacheScope === scope
  const operation = (lane.get(intent.trackId) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (!owned()) return
      const favorites = useFavoritesStore.getState()
      if (
        favorites.provider !== provider ||
        favorites.session !== session ||
        !favorites.loaded
      )
        throw Error("Reload local ratings before saving to Plex")
      const current = favorites.ratingsByTrackId.get(intent.trackId)
      // A later local edit or remote unlike can supersede an unconfirmed star write.
      if (
        current?.manual?.id !== intent.id ||
        effectiveTrackRating(null, current) !== intent.value
      )
        return
      if (provider.isOffline)
        throw Error(
          "Rating saved in Hibiki. Reconnect, then use More → Save rating to Plex."
        )
      try {
        await provider.rate(intent.trackId, intent.value)
      } catch {
        throw Error(
          "Rating saved in Hibiki. Plex could not be updated; use More → Save rating to Plex to retry."
        )
      }
      if (!owned()) return
      useLibraryStore
        .getState()
        .onItemRated(intent.trackId, "track", intent.value)
      await useFavoritesStore.getState().confirmRating(intent, provider)
    })
  lane.set(intent.trackId, operation)
  void operation
    .finally(() => {
      if (lane!.get(intent.trackId) === operation) lane!.delete(intent.trackId)
    })
    .catch(() => {})
  return operation
}
