import type { MatchingUpdate } from "./updates"
import type { MatchingSource } from "./resolverTypes"
import { playlistSearchTitle } from "../playlistSync/matching"
import type { MusicTrack } from "../types/music"

export function matchingUpdateAffects(update: MatchingUpdate, source: MatchingSource, selected?: number | string | null) {
  return update.reset || update.coverageChanged || update.changes.some(change => change.kind === source.kind && (!selected || String(change.id) === String(selected)))
}
export const matchingKey = (value: string) => value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ")
const trackKeys = new WeakMap<MusicTrack, string[]>()
export function matchingUpdateAffectsRecording(update: MatchingUpdate, track: MusicTrack) {
  if (update.reset || update.coverageChanged) return true
  let keys = trackKeys.get(track)
  if (!keys) {
    keys = [matchingKey(track.title), matchingKey(playlistSearchTitle({ id: track.id, title: track.title, artist: track.artistName }))]
    trackKeys.set(track, keys)
  }
  return update.changes.some(change => change.kind === "track" && (String(change.id) === track.id || !!change.titleKey && keys!.includes(change.titleKey)))
}
