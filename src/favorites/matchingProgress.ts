import type { FavoriteState } from "./types"
const DAY = 86400000
/** Saved check times make the backlog finite across worker turns and restarts. */
export function favoriteMatchBacklog(state: FavoriteState, force = false, now = Date.now()) {
  return Object.values(state.entries).filter(item => item.liked &&
    (force || !item.matchCheckedAt || now - item.matchCheckedAt >= DAY) &&
    (!item.localTrackIds.length || (state.settings.listenbrainz && !item.recordingMbid && !item.recordingMsid)))
    .sort((a, b) => (a.matchCheckedAt ?? 0) - (b.matchCheckedAt ?? 0))
}
export function favoriteMatchingProgress(state: FavoriteState, due: number, now = Date.now()) {
  const checked = Object.values(state.entries).filter(item => item.liked && item.matchCheckedAt && now - item.matchCheckedAt < DAY).length
  return { checked, total: checked + due }
}
