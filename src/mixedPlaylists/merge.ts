import type { MusicTrack } from "../types/music"
import type { MixedAdapter } from "./adapters"
import type { CounterpartResult } from "./matching"
import { COUNTERPART_POLICY, counterpartAttempt, counterpartDeferred, counterpartFailure, recordingFingerprint } from "./matching"
import { newDraft, type DraftMetadata } from "./drafts"
import { newOccurrence, verifiedSongReference, type MixedOccurrence, type MixedPlaylist, type Owners, type Service } from "./model"
import { reconcileRemoteChanges } from "./reconcile"
import { deduplicateMergeItems } from "./deduplicate"

export type MergeDestination = Service | "mixed"
export type MergeDuplicates = "preserve" | "verified"
export interface MergeSource { key: string; title: string; fingerprint: string; owners: Owners; items: MixedOccurrence[] }
export interface MergePreview {
  sources: [MergeSource, MergeSource]
  destination: MergeDestination
  duplicates: MergeDuplicates
  items: MixedOccurrence[]
  removed: number
  reviewedAt: number
  owners: Owners
}
export const mergeServices = (destination: MergeDestination): Service[] => destination === "mixed" ? ["plex", "ytmusic"] : [destination]
export const sourceFingerprint = (value: unknown) => JSON.stringify(value)
export interface MergeSelection { key: string; title: string }
/** Persist the request before any provider reads or matching. */
export function queuedMerge(sources: [MergeSelection, MergeSelection], destination: MergeDestination, duplicates: MergeDuplicates, metadata: DraftMetadata, owners: Owners, id: string): MixedPlaylist {
  if (!sources[0]?.key || !sources[1]?.key || sources[0].key === sources[1].key) throw Error("Choose two different playlists.")
  for (const service of mergeServices(destination)) if (!owners[service]) throw Error(`Connect ${service === "plex" ? "Plex" : "YouTube Music"}.`)
  return { ...newDraft(metadata, id), owners: { ...owners }, destinations: mergeServices(destination),
    merge: { sources: sources.map(source => ({ ...source, fingerprint: "" })), duplicates, reviewedAt: Date.now(), pending: true },
    status: "syncing", message: "Preparing the source playlists in the background." }
}
export function removeVerifiedMergeDuplicates(playlist: MixedPlaylist): MixedPlaylist {
  if (playlist.merge?.duplicates !== "verified" || playlist.write) return playlist
  const items = deduplicateMergeItems(playlist.items)
  return items.length === playlist.items.length ? playlist : { ...playlist, items }
}
/** Read only, using the same complete paged readers as ordinary playlist sync. */
export async function readMergeSource(key: string, options: {
  adapters: Partial<Record<Service, MixedAdapter>>; owners: Owners; current(): boolean; local(): Promise<MixedPlaylist[]>
}): Promise<MergeSource> {
  const check = () => { if (!options.current()) throw Error("Music accounts changed. Review the merge again.") }
  check()
  // A provider ID explicitly selects that provider's contents. Mixed entries
  // have their own IDs; aliases must not silently replace either merge source.
  const local = (await options.local()).find(item => item.id === key)
  check()
  if (local) {
    if (local.merge?.pending) throw Error("The source playlist is still being prepared. Hibiki will retry.")
    if (Object.entries(local.owners).some(([service, owner]) => options.owners[service as Service] !== owner)) throw Error("Reconnect the source playlist’s original accounts.")
    if (local.write || local.status === "conflict") throw Error(`Resolve the pending sync for “${local.title}” before merging it.`)
    const snapshots = []
    for (const service of ["plex", "ytmusic"] as const) if (local.providers[service]) {
      const adapter = options.adapters[service]
      if (!adapter || adapter.owner !== local.owners[service]) throw Error("Reconnect the source playlist’s original accounts.")
      snapshots.push(await adapter.read(local.providers[service]!.id)); check()
    }
    const fresh = reconcileRemoteChanges(local, snapshots)
    if (fresh.status === "conflict") throw Error(`“${local.title}” changed in more than one place. Resolve its sync before merging.`)
    const items = structuredClone(fresh.items)
    return { key, title: fresh.title, owners: fresh.owners, items,
      fingerprint: sourceFingerprint([fresh.title, fresh.description, fresh.owners, items.map(row => [row.original,
        (["plex", "ytmusic"] as const).map(service => [row.songs[service] ? recordingFingerprint(row.songs[service]!.track) : null, !!row.songs[service]?.stale, row.remote[service]?.occurrenceId]),
        row.added.provenance === "observed" ? "observed" : row.added])]) }
  }
  const service = key.startsWith("ytmusic:") ? "ytmusic" : "plex"
  const adapter = options.adapters[service]
  if (!adapter || adapter.owner !== options.owners[service]) throw Error("Connect the source playlist’s account to read all its songs.")
  const snapshot = await (adapter.readSource ?? adapter.read)(key.replace(/^ytmusic:/, "")); check()
  const items = snapshot.items.map(item => {
    const row = newOccurrence(item.track)
    if (item.unavailable) row.songs[row.original]!.stale = true
    return { ...row, added: item.added ?? { at: Date.now(), provenance: "observed" as const }, copiedFrom: { playlist: key, occurrence: item.occurrenceId } }
  })
  return { key, title: snapshot.title, owners: { [service]: snapshot.owner }, items,
    fingerprint: sourceFingerprint([snapshot.title, snapshot.description, snapshot.owner, snapshot.items.map(item => [item.occurrenceId, recordingFingerprint(item.track), item.added])]) }
}
function copiedOccurrence(row: MixedOccurrence, key: string): MixedOccurrence {
  return { ...structuredClone(row), id: crypto.randomUUID(), remote: {}, copiedFrom: { playlist: key, occurrence: row.copiedFrom?.occurrence ?? row.id } }
}
export function mergeDuplicateCount(items: MixedOccurrence[]) {
  return items.length - deduplicateMergeItems(items).length
}
/** Join local source recordings first, then use two bounded provider lookups. */
export async function prepareMerge(sources: [MergeSource, MergeSource], destination: MergeDestination, duplicates: MergeDuplicates, options: {
  owners: Owners; current(): boolean; resolve(track: MusicTrack, target: Service): Promise<CounterpartResult>; progress?(done: number, total: number): void
}): Promise<MergePreview> {
  if (sources[0].key === sources[1].key) throw Error("Choose two different playlists.")
  const services = mergeServices(destination)
  for (const service of services) if (!options.owners[service]) throw Error(`Connect ${service === "plex" ? "Plex" : "YouTube Music"} to create this destination.`)
  const copied = sources.flatMap(source => source.items.map(row => copiedOccurrence(row, source.key)))
  if (copied.length > 10000) throw Error("A merged playlist can contain at most 10,000 occurrences. Choose smaller sources.")
  const items = duplicates === "verified" ? deduplicateMergeItems(copied) : copied
  const lookups = new Map<string, Promise<CounterpartResult>>()
  const deferred = new Map<Service, CounterpartResult>()
  let cancelled = false
  const check = () => { if (cancelled || !options.current()) throw Error("Merge cancelled or music accounts changed. Review it again.") }
  let cursor = 0, done = 0
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
    while (cursor < items.length) {
      check()
      const row = items[cursor++]
      const original = row.songs[row.original]
      if (!original) throw Error("A source occurrence is incomplete. Reload the source playlist.")
      for (const target of services) {
        if (row.songs[target] && !row.songs[target]?.stale) continue
        const key = sourceFingerprint([target, recordingFingerprint(original.track)])
        let lookup = lookups.get(key)
        if (!lookup) { lookup = deferred.has(target) ? Promise.resolve(deferred.get(target)!) : options.resolve(original.track, target).catch(counterpartFailure); lookups.set(key, lookup) }
        const result = await lookup; check()
        if (counterpartDeferred(result)) deferred.set(target, result)
        if (result.status === "matched") row.songs[target] = verifiedSongReference(result.track)
        row.match = counterpartAttempt(result)
      }
      if (services.every(service => row.songs[service] && !row.songs[service]?.stale)) row.match = { ...row.match, status: "matched", policy: COUNTERPART_POLICY }
      options.progress?.(++done, items.length)
    }
  })).catch(error => { cancelled = true; throw error })
  check()
  const retained = duplicates === "verified" ? deduplicateMergeItems(items) : items
  return { sources, destination, duplicates, items: retained, removed: copied.length - retained.length, reviewedAt: Date.now(), owners: { ...options.owners } }
}
export function mergedDraft(preview: MergePreview, metadata: DraftMetadata, owners: Owners, id: string): MixedPlaylist {
  const destinations = mergeServices(preview.destination), bound: Owners = {}
  for (const source of preview.sources) for (const [service, owner] of Object.entries(source.owners)) {
    if (owners[service as Service] !== owner) throw Error("Source account changed. Review the merge again.")
    bound[service as Service] = owner
  }
  for (const service of destinations) {
    if (!owners[service] || owners[service] !== preview.owners[service]) throw Error("Destination account changed. Review the merge again.")
    bound[service] = owners[service]
  }
  const draft = newDraft(metadata, id)
  return { ...draft, owners: bound, destinations, items: structuredClone(preview.items),
    baselineOrder: preview.items.map(row => row.id),
    merge: { sources: preview.sources.map(({ key, title, fingerprint }) => ({ key, title, fingerprint })), duplicates: preview.duplicates, reviewedAt: preview.reviewedAt },
    message: "Merge saved in Hibiki. Verified songs will sync to the selected destinations; missing songs remain here." }
}
/** Fail closed if either complete source changed since review. */
export async function revalidateMerge(preview: MergePreview, read: (key: string) => Promise<MergeSource>) {
  for (const source of preview.sources) {
    const fresh = await read(source.key)
    if (fresh.fingerprint !== source.fingerprint) throw Error(`“${source.title}” changed since review. Review the merge again.`)
  }
}
