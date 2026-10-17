import type { FavoriteService, FavoriteState } from "../favorites/types"
import type { LinkedPlaylist } from "../playlistSync/linked"

/** Review belongs to its collection, without creating a global notification. */
export function favoritesNeedReview(
  collection: FavoriteState,
  issues: Partial<Record<FavoriteService, string>> = {}
) {
  return (
    Object.entries(collection.settings).some(
      ([service, enabled]) => enabled && !!issues[service as FavoriteService]
    ) ||
    Object.values(collection.bindings).some(
      (binding) => binding?.pending || binding?.creation
    ) ||
    Object.values(collection.entries).some(
      (entry) =>
        entry.liked &&
        (!entry.localTrackIds.length ||
          (collection.settings.listenbrainz &&
            !entry.recordingMbid &&
            !entry.recordingMsid))
    )
  )
}

export function playlistNeedsReview(
  link: LinkedPlaylist | undefined,
  checkedError = false,
  held = false
) {
  if (!link) return false
  return (
    checkedError ||
    held ||
    link.state !== "ready" ||
    (link.paused && link.pauseReason !== "manual") ||
    !!(
      link.incomplete?.matchingDone &&
      (link.incomplete.missingOccurrenceIds.length ||
        link.incomplete.lookupLimits?.length)
    ) ||
    link.job?.step?.state === "unknown" ||
    link.job?.descriptionStep?.state === "unknown"
  )
}
