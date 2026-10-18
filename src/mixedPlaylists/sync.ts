import type { MixedAdapter } from "./adapters"
import { appendBatchIds, bindSnapshot, nextMixedOperation, operationIds, projection, reconcileRemoteChanges, unsupportedPlexRepeats } from "./reconcile"
import { playlistServices, sameSequence, snapshotIds, type MixedPlaylist, type RemotePlaylist, type Service } from "./model"

export interface MixedSyncOptions {
  adapters: Partial<Record<Service, MixedAdapter>>
  current: () => boolean
  save: (playlist: MixedPlaylist) => Promise<MixedPlaylist>
  maxWrites?: number
  verify?: (playlist: MixedPlaylist, snapshots: RemotePlaylist[]) => Promise<MixedPlaylist>
}
export function mixedWriteOutcome(receipt: NonNullable<MixedPlaylist["write"]>, actual: RemotePlaylist): "applied" | "unchanged" | "diverged" {
  const before = receipt.before
  if (actual.service !== receipt.service || actual.readOnly || before && (before.id !== actual.id || before.owner !== actual.owner)) return "diverged"
  if (sameSequence(snapshotIds(actual), receipt.afterIds)) return "applied"
  // A full fresh snapshot, including occurrence IDs, confirms that this edit
  // never took effect. A read with changed handles is not an unchanged playlist.
  if (receipt.kind !== "create" && before && sameSequence(snapshotIds(actual), snapshotIds(before)) &&
    sameSequence(actual.items.map(item => item.occurrenceId), before.items.map(item => item.occurrenceId))) return "unchanged"
  return "diverged"
}
const failureMessage = (failure: unknown) => failure instanceof Error ? failure.message : String(failure)
/** A receipt is durably retained before every write. Unknown creations never
 * create again; unknown edits can settle only against a fresh exact post-read. */
export async function syncMixedPlaylist(initial: MixedPlaylist, options: MixedSyncOptions) {
  let playlist = initial, budget = options.maxWrites ?? 10
  const services = playlistServices(playlist)
  // Empty drafts never create resources; existing lists can receive removals.
  if (!services.length || (!playlist.merge && !playlist.items.length && !Object.keys(playlist.providers).length)) return playlist
  const owns = () => {
    if (!options.current()) throw Error("Music accounts changed. Sync will resume when the original accounts reconnect.")
    for (const service of services) {
      if (playlist.owners[service] && options.adapters[service]?.owner !== playlist.owners[service]) throw Error("Reconnect this playlist's original accounts to sync.")
    }
  }
  const save = async (next: MixedPlaylist) => { owns(); playlist = await options.save(next); owns(); return playlist }
  const snapshots: RemotePlaylist[] = []
  owns()
  if (playlist.write) {
    const receipt = playlist.write, adapter = options.adapters[receipt.service]!
    const id = receipt.destinationId ?? playlist.providers[receipt.service]?.id
    if (!id) throw Error("A playlist creation has an unknown outcome. Select the playlist created on that service to recover it; another copy will not be created.")
    const actual = await adapter.read(id); owns()
    const outcome = mixedWriteOutcome(receipt, actual)
    if (outcome === "diverged") throw Error("The pending playlist write has an uncertain outcome. Review the provider's current contents before retrying." + (receipt.failure ? ` ${receipt.failure}` : ""))
    if (options.verify) playlist = await options.verify(playlist, [actual])
    owns()
    const providers = { ...playlist.providers, [receipt.service]: { id: actual.id, readOnly: actual.readOnly } }
    await save({ ...playlist, providers, baseline: { ...playlist.baseline, [receipt.service]: actual }, write: undefined, status: "syncing", message: undefined })
    if (outcome === "applied" && receipt.kind !== "create" && sameSequence(projection(playlist, receipt.service).map(row => row.songs[receipt.service]!.track.id), snapshotIds(actual)))
      await save(bindSnapshot(playlist, actual))
  }
  for (const service of services) {
    const ref = playlist.providers[service]
    if (ref) { const snapshot = await options.adapters[service]!.read(ref.id); owns(); snapshots.push(snapshot) }
  }
  if (options.verify) playlist = await options.verify(playlist, snapshots)
  owns()
  if (!playlist.merge && playlist.items.some(row => Object.values(row.songs).some(song => song?.stale))) {
    return save({ ...playlist, status: "error", message: "A saved recording changed or became unavailable. Its original song and playlist position are retained. Choose Match and sync to retry." })
  }
  if (playlist.status === "conflict") return playlist
  // A missing catalogue recording is not permission to remove its occurrence.
  // Pause that existing destination while other verified destinations progress.
  const blocked = new Set(services.filter(service => playlist.items.some(row => row.songs[service]?.stale && row.remote[service])))
  const reconciled = await save(reconcileRemoteChanges(playlist, snapshots.filter(snapshot => !blocked.has(snapshot.service))))
  if (reconciled.status === "conflict") return reconciled
  for (const service of services) {
    if (blocked.has(service)) continue
    const adapter = options.adapters[service]!
    if (!playlist.providers[service]) {
      if (!playlist.merge && !playlist.items.length) continue
      if (!budget) return playlist
      await save({ ...playlist, status: "syncing", write: { id: crypto.randomUUID(), kind: "create", service, afterIds: [], state: "admitted" } })
      budget--
      try {
        const id = await adapter.create(playlist.title); owns()
        await save({ ...playlist, write: { ...playlist.write!, destinationId: id } })
        const actual = await adapter.read(id); owns()
        if (actual.readOnly || actual.items.length) throw Error("The created playlist did not match its empty creation receipt.")
        await save({ ...playlist, providers: { ...playlist.providers, [service]: { id, readOnly: false } },
          aliases: [...new Set([...playlist.aliases, service === "ytmusic" ? `ytmusic:${id}` : id])],
          baseline: { ...playlist.baseline, [service]: actual }, write: undefined })
      } catch (failure) { if (options.current()) await save({ ...playlist, write: { ...playlist.write!, state: "unknown", failure: failureMessage(failure) } }); throw failure }
    }
    let before = playlist.baseline[service]!
    if (before.readOnly) throw Error("Smart, generated and read-only playlists cannot be sync destinations.")
    const desiredRows = projection(playlist, service), desired = desiredRows.map(row => row.songs[service]!.track.id)
    while (budget > 0) {
      owns()
      const operation = nextMixedOperation(snapshotIds(before), desired)
      if (!operation) break
      const additions = operation.kind === "append" && adapter.appendMany
        ? appendBatchIds(snapshotIds(before), desired, service === "plex" ? 500 : 100) : []
      const batched = additions.length > 1
      const afterIds = batched ? [...snapshotIds(before), ...additions] : operationIds(snapshotIds(before), operation)
      await save({ ...playlist, status: "syncing", write: { id: crypto.randomUUID(), service, kind: operation.kind, before, afterIds, state: "admitted" } })
      budget--
      try {
        if (batched) await adapter.appendMany!(before, additions)
        else await adapter.mutate(before, operation)
        owns()
        let actual = await adapter.read(before.id); owns()
        // A post-read may still show the order from before an acknowledged edit.
        // Confirm once, paced by the shared limiter; never replay the mutation.
        if (service === "ytmusic" && !sameSequence(snapshotIds(actual), afterIds)) {
          actual = await adapter.read(before.id); owns()
        }
        if (!sameSequence(snapshotIds(actual), afterIds)) throw Error("Provider contents did not match the expected write. Review this playlist.")
        await save({ ...playlist, baseline: { ...playlist.baseline, [service]: actual }, write: undefined })
        before = actual
      } catch (failure) { if (options.current()) await save({ ...playlist, write: { ...playlist.write!, state: "unknown", failure: failureMessage(failure) } }); throw failure }
    }
    if (!sameSequence(snapshotIds(before), desired)) return playlist
    await save(bindSnapshot(playlist, before))
  }
  const unmatched = playlist.items.filter(row => services.some(service => !row.songs[service] || row.songs[service]?.stale)).length
  const repeats = unsupportedPlexRepeats(playlist)
  return save({ ...playlist, status: blocked.size ? "error" : "ready", baselineOrder: blocked.size ? playlist.baselineOrder : playlist.items.map(row => row.id), baselineTitle: blocked.size ? playlist.baselineTitle : playlist.title,
    message: [unmatched ? `${unmatched} unmatched songs retained in Hibiki.` : services.length === 2 ? "Both playlists are up to date." : "Playlist is up to date.",
      repeats ? `${repeats} repeated copies are retained in Hibiki${services.includes("ytmusic") ? " and YTM" : ""}; Plex cannot retain these duplicates.` : "",
      blocked.size ? "A destination has unavailable saved recordings; its writes are paused until rematched. Other destinations can continue." : ""].filter(Boolean).join(" ") })
}
