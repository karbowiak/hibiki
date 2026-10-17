import type { FavoriteState } from "./types"

/** Plex's native 0–10 scale; the visible three-star boundary is always 6/10. */
export const LIKED_RATING = 6
export interface FavoriteRatingIntent {
  id: string
  trackId: string
  value: number | null
  changedAt: number
  plexSaved: boolean
}
export interface FavoriteTrackRating {
  liked: boolean
  manual?: FavoriteRatingIntent
  sources: string
}

/** Build once per saved change; visible track rows perform an O(1) lookup. */
export function favoriteRatingIndex(
  state: FavoriteState,
  previous = new Map<string, FavoriteTrackRating>()
) {
  const result = new Map<string, FavoriteTrackRating>()
  for (const entry of Object.values(state.entries)) {
    for (const id of entry.localTrackIds) {
      const old = result.get(id)
      const manual =
        !old?.manual || (entry.rating?.changedAt ?? 0) > old.manual.changedAt
          ? (entry.rating ?? old?.manual)
          : old.manual
      const sources = new Set((old?.sources ?? "").split(", ").filter(Boolean))
      if (entry.liked)
        for (const [service, source] of Object.entries(entry.sources))
          if (source?.liked) sources.add(service)
      result.set(id, {
        liked: !!old?.liked || entry.liked,
        manual,
        sources: [...sources].sort().join(", "),
      })
    }
  }
  for (const [id, value] of result) {
    const old = previous.get(id)
    if (
      old?.liked === value.liked &&
      old.manual === value.manual &&
      old.sources === value.sources
    )
      result.set(id, old)
  }
  return result
}

/** The overlay never mutates MusicTrack.userRating or calls a provider write. */
export function effectiveTrackRating(
  plexRating: number | null | undefined,
  favorite?: FavoriteTrackRating
): number | null {
  const raw =
    typeof plexRating === "number" &&
    Number.isFinite(plexRating) &&
    plexRating > 0 &&
    plexRating <= 10
      ? plexRating
      : null
  if (!favorite) return raw
  const manual = favorite.manual?.value
  if (!favorite.liked)
    return manual != null && manual < LIKED_RATING
      ? manual
      : raw != null && raw < LIKED_RATING && !favorite.manual
        ? raw
        : null
  if (manual != null && manual >= LIKED_RATING) return manual
  return raw != null && raw >= LIKED_RATING ? raw : LIKED_RATING
}
export function trackRatingHint(
  plexRating: number | null | undefined,
  favorite?: FavoriteTrackRating
): string | undefined {
  if (!favorite) return undefined
  if (favorite.manual && !favorite.manual.plexSaved)
    return "Rating saved in Hibiki. Use More → Save rating to Plex to update Plex."
  if (
    favorite.liked &&
    effectiveTrackRating(plexRating, favorite) === LIKED_RATING &&
    (plexRating ?? 0) < LIKED_RATING
  ) {
    const source =
      favorite.sources
        .replaceAll("listenbrainz", "ListenBrainz")
        .replaceAll("lastfm", "Last.fm")
        .replaceAll("plex", "Plex playlist") || "Hibiki"
    return `Liked via ${source}. Three stars are stored locally; Plex's rating is unchanged.`
  }
  if (!favorite.liked && (plexRating ?? 0) >= LIKED_RATING)
    return "Unliked in Hibiki. Plex's original rating is unchanged."
  return undefined
}
export function favoriteRatingIntent(
  value: number | null,
  trackId: string
): FavoriteRatingIntent {
  if (!/^[1-9]\d*$/.test(trackId) || !Number.isSafeInteger(Number(trackId)))
    throw Error("Choose a library track")
  if (value !== null && ![2, 4, 6, 8, 10].includes(value))
    throw Error(
      "Choose a whole star rating from one to five, or clear the rating"
    )
  return {
    id: crypto.randomUUID(),
    trackId,
    value,
    changedAt: Date.now(),
    plexSaved: false,
  }
}
