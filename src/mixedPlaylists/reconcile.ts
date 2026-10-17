import { newOccurrence, songReference, sameSequence, snapshotIds, type MixedOccurrence, type MixedPlaylist, type RemotePlaylist, type Service } from "./model"
import type { SequenceOperation } from "../playlistSync/linked"

export function projection(playlist: MixedPlaylist, service: Service) {
  const seen = new Set<string>()
  const represented = new Set(playlist.items.flatMap(row => service === "plex" && row.remote.plex && row.songs.plex ? [row.songs.plex.track.id] : []))
  return playlist.items.filter(row => {
    const id = row.songs[service]?.track.id
    if (!id || (service === "plex" && !row.remote.plex && (seen.has(id) || represented.has(id)))) return false
    seen.add(id)
    return true
  })
}
/** Unsupported Plex repeats remain local/YTM occurrences and are explicitly
 * excluded from Plex's projection, rather than collapsed in the local model. */
export function unsupportedPlexRepeats(playlist: MixedPlaylist) {
  return playlist.items.filter(row => row.songs.plex).length - projection(playlist, "plex").length
}
export function bindSnapshot(playlist: MixedPlaylist, snapshot: RemotePlaylist): MixedPlaylist {
  const projected = projection(playlist, snapshot.service)
  if (!sameSequence(projected.map(row => row.songs[snapshot.service]!.track.id), snapshotIds(snapshot)))
    throw Error("The provider did not retain the expected playlist order.")
  const handles = new Map(projected.map((row, index) => [row.id, snapshot.items[index]]))
  return { ...playlist, items: playlist.items.map(row => {
    const item = handles.get(row.id)
    if (!item) {
      const remote = { ...row.remote }; delete remote[snapshot.service]
      return { ...row, remote }
    }
    return { ...row, songs: { ...row.songs, [snapshot.service]: songReference(item.track, row.songs[snapshot.service]) },
      remote: { ...row.remote, [snapshot.service]: { occurrenceId: item.occurrenceId,
      added: row.remote[snapshot.service]?.added ?? item.added ?? row.added } } }
  }), baseline: { ...playlist.baseline, [snapshot.service]: snapshot } }
}
function remoteChanged(a: RemotePlaylist, b: RemotePlaylist) {
  return a.title !== b.title || !sameSequence(a.items.map(item => `${item.occurrenceId}:${item.track.id}`), b.items.map(item => `${item.occurrenceId}:${item.track.id}`))
}
/** Apply edits only to occurrences present in the last verified source snapshot.
 * Hidden/unmatched entries retain their relative anchor and never look deleted. */
export function adoptRemote(playlist: MixedPlaylist, snapshot: RemotePlaylist): MixedPlaylist {
  const service = snapshot.service, baseline = playlist.baseline[service]
  if (!baseline || baseline.owner !== snapshot.owner || baseline.id !== snapshot.id) throw Error("Playlist connection identity changed.")
  const known = new Map(playlist.items.flatMap(row => row.remote[service] ? [[row.remote[service]!.occurrenceId, row] as const] : []))
  const baselineHandles = new Set(baseline.items.map(item => item.occurrenceId))
  const currentHandles = new Set(snapshot.items.map(item => item.occurrenceId))
  const deleted = new Set(playlist.items.filter(row => {
    const handle = row.remote[service]?.occurrenceId
    return handle && baselineHandles.has(handle) && !currentHandles.has(handle)
  }).map(row => row.id))
  const changed: MixedOccurrence[] = snapshot.items.map(item => {
    const before = known.get(item.occurrenceId)
    if (before && before.songs[service]?.track.id !== item.track.id) throw Error("A playlist occurrence changed recording identity.")
    const row = before ?? newOccurrence(item.track)
    return { ...row, songs: { ...row.songs, [service]: songReference(item.track, row.songs[service]) },
      added: before?.added ?? item.added ?? { at: Date.now(), provenance: "observed" },
      remote: { ...row.remote, [service]: { occurrenceId: item.occurrenceId, added: item.added ?? before?.remote[service]?.added } } }
  })
  const visible = new Set(changed.map(row => row.id))
  for (let index = playlist.items.length - 1; index >= 0; index--) {
    const row = playlist.items[index]
    if (visible.has(row.id) || deleted.has(row.id)) continue
    const next = playlist.items.slice(index + 1).find(item => !deleted.has(item.id) && changed.some(row => row.id === item.id))
    const at = next ? changed.findIndex(row => row.id === next.id) : changed.length
    changed.splice(at, 0, row)
  }
  return { ...playlist, title: snapshot.title, items: changed, baseline: { ...playlist.baseline, [service]: snapshot } }
}
export function reconcileRemoteChanges(playlist: MixedPlaylist, snapshots: RemotePlaylist[]): MixedPlaylist {
  const changed = snapshots.filter(snapshot => {
    const baseline = playlist.baseline[snapshot.service]
    if (!baseline || baseline.id !== snapshot.id || baseline.owner !== snapshot.owner) throw Error("Playlist baseline is missing or belongs to another account.")
    return remoteChanged(baseline, snapshot)
  })
  if (!changed.length) return playlist
  const localChanged = playlist.baselineOrder && (!sameSequence(playlist.items.map(row => row.id), playlist.baselineOrder) || playlist.title !== playlist.baselineTitle)
  if (localChanged || changed.length > 1) return { ...playlist, status: "conflict", message: "This playlist changed in more than one place. Choose which current order to keep before syncing." }
  return adoptRemote(playlist, changed[0])
}
export function nextMixedOperation(before: string[], desired: string[]): SequenceOperation | null {
  for (let index = 0; index < desired.length; index++) {
    if (before[index] === desired[index]) continue
    const found = before.indexOf(desired[index], index + 1)
    if (found >= 0) return { kind: "move", from: found, to: index }
    if (before.length >= 10000) throw Error("Playlist capacity requires review.")
    return { kind: "append", trackId: desired[index] }
  }
  return before.length > desired.length ? { kind: "delete", index: before.length - 1 } : null
}
export function operationIds(ids: string[], operation: SequenceOperation) {
  const result = [...ids]
  if (operation.kind === "append") result.push(operation.trackId)
  else if (operation.kind === "delete") result.splice(operation.index, 1)
  else { const [id] = result.splice(operation.from, 1); result.splice(operation.to, 0, id) }
  return result
}
