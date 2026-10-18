import { lastfmFavoriteKey } from "./model"
import type { FavoriteState, FavoriteService } from "./types"

/** Only executable membership changes count as pending work. Unknown receipts
 * must be inspected first; unmatched recordings and disabled services are idle. */
export function favoriteSyncCandidates(state: FavoriteState, service: FavoriteService) {
  if (!state.settings[service]) return []
  const entries = Object.values(state.entries)
  const lovedIds = new Set(entries.filter(item => item.liked).flatMap(item => item.localTrackIds))
  const lovedLastfm = new Set(service === "lastfm" ? entries.filter(item => item.liked).map(lastfmFavoriteKey) : [])
  return entries.filter(item => {
    if ((item.sources[service]?.liked ?? false) === item.liked) return false
    if (service === "plex") return item.localTrackIds.length > 0 && (item.liked || !item.localTrackIds.some(id => lovedIds.has(id)))
    if (service === "listenbrainz") return !!(item.recordingMbid || item.recordingMsid)
    return !!item.title && !!item.artist && (item.liked || !lovedLastfm.has(lastfmFavoriteKey(item)))
  })
}
export function pendingFavoriteSync(state: FavoriteState) {
  return (["plex", "listenbrainz", "lastfm"] as const).reduce((total, service) => {
    const binding = state.bindings[service]
    return total + (!binding?.initialized || binding.pending || binding.creation ? 0 : favoriteSyncCandidates(state, service).length)
  }, 0)
}
