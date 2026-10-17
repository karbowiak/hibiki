import type { MusicTrack } from "../types/music"

export type Service = "plex" | "ytmusic"
/** Opaque, durable identities; runtime sessions are fenced separately. */
export type Owners = Partial<Record<Service, string>>
export interface AddedDate {
  at: number
  provenance: "provider" | "observed" | "hibiki"
}
export interface SongReference {
  track: MusicTrack
  /** Library membership date, never substituted for the playlist-added date. */
  libraryAdded?: AddedDate
  /** Retained even after an authoritative provider date becomes available. */
  libraryObservedAt?: number
}
export interface MixedOccurrence {
  id: string
  original: Service
  songs: Partial<Record<Service, SongReference>>
  added: AddedDate
  remote: Partial<Record<Service, { occurrenceId: string; added?: AddedDate }>>
  match: { status: "pending" | "matched" | "missing" | "ambiguous" | "failed"; checkedAt?: number; message?: string }
}
export interface RemotePlaylist {
  service: Service
  owner: string
  id: string
  title: string
  readOnly: boolean
  items: { occurrenceId: string; track: MusicTrack; added?: AddedDate }[]
}
export interface MixedPlaylist {
  version: 1
  revision: number
  id: string
  title: string
  owners: Owners
  /** Original sidebar identity stays usable after conversion. */
  aliases: string[]
  providers: Partial<Record<Service, { id: string; readOnly: boolean }>>
  items: MixedOccurrence[]
  createdAt: number
  automatic: boolean
  status: "ready" | "matching" | "syncing" | "conflict" | "error"
  message?: string
  baseline: Partial<Record<Service, RemotePlaylist>>
  baselineOrder?: string[]
  baselineTitle?: string
  /** Saved before an external write. An uncertain write is read back, never blindly retried. */
  write?: { id: string; service: Service; kind: "create" | "append" | "delete" | "move"; before?: RemotePlaylist; afterIds: string[]; destinationId?: string; state: "admitted" | "unknown" }
  admittedDrops: string[]
}

export function sameOwners(a: Owners, b: Owners) {
  return a.plex === b.plex && a.ytmusic === b.ytmusic
}
export function trackService(track: MusicTrack): Service {
  return track.id.startsWith("ytmusic:") ? "ytmusic" : "plex"
}
export function playlistAlias(service: Service, id: string) {
  return service === "ytmusic" ? `ytmusic:${id}` : id
}
export function songReference(track: MusicTrack, previous?: SongReference, at = Date.now()): SongReference {
  const native = track.addedAt ? Date.parse(track.addedAt) : NaN
  const observed = track.libraryObservedAt ? Date.parse(track.libraryObservedAt) : NaN
  const observedAt = previous?.libraryObservedAt ?? (previous?.libraryAdded?.provenance === "observed" ? previous.libraryAdded.at : Number.isFinite(observed) ? observed : at)
  return { track, libraryObservedAt: observedAt, libraryAdded: Number.isFinite(native) ? { at: native, provenance: "provider" } :
    previous?.libraryAdded ?? { at: observedAt, provenance: "observed" } }
}
export function newOccurrence(track: MusicTrack, at = Date.now()): MixedOccurrence {
  const original = trackService(track)
  return { id: crypto.randomUUID(), original, songs: { [original]: songReference(track, undefined, at) },
    added: { at, provenance: "hibiki" }, remote: {}, match: { status: "pending" } }
}
/** Hydration uses transport occurrence handles, not song IDs: repeats stay distinct. */
export function hydratePlaylist(snapshot: RemotePlaylist, previous?: MixedPlaylist, now = Date.now()): MixedPlaylist {
  if (previous && previous.owners[snapshot.service] !== snapshot.owner) throw Error("Playlist account changed.")
  const alias = playlistAlias(snapshot.service, snapshot.id)
  if (previous && previous.providers[snapshot.service]?.id !== snapshot.id) throw Error("Playlist identity changed.")
  const old = new Map(previous?.items.flatMap(row => row.remote[snapshot.service] ? [[row.remote[snapshot.service]!.occurrenceId, row] as const] : []) ?? [])
  const items = snapshot.items.map(item => {
    const retained = old.get(item.occurrenceId)
    if (retained && retained.songs[snapshot.service]?.track.id !== item.track.id) throw Error("Playlist occurrence identity changed.")
    const row = retained ?? newOccurrence(item.track, now)
    const before = row.songs[snapshot.service]
    return { ...row, songs: { ...row.songs, [snapshot.service]: songReference(item.track, before, now) },
      added: retained?.added ?? item.added ?? { at: now, provenance: "observed" as const },
      remote: { ...row.remote, [snapshot.service]: { occurrenceId: item.occurrenceId, added: item.added ?? row.remote[snapshot.service]?.added } } }
  })
  return { version: 1, revision: previous?.revision ?? 0, id: previous?.id ?? `mixed:${crypto.randomUUID()}`,
    title: snapshot.title, owners: { ...previous?.owners, [snapshot.service]: snapshot.owner },
    aliases: [...new Set([...(previous?.aliases ?? []), alias])],
    providers: { ...previous?.providers, [snapshot.service]: { id: snapshot.id, readOnly: snapshot.readOnly } },
    items, createdAt: previous?.createdAt ?? now, automatic: previous?.automatic ?? false,
    status: previous?.status ?? "ready", baseline: { ...previous?.baseline, [snapshot.service]: snapshot },
    admittedDrops: previous?.admittedDrops ?? [], ...(previous?.write ? { write: previous.write } : {}) }
}
export const snapshotIds = (snapshot: RemotePlaylist) => snapshot.items.map(item => item.track.id)
export const sameSequence = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index])
