import { validateSnapshot } from "./planner"
import { recordingMbid } from "./matching"
import {
  samePlaylistIdentity,
  type PlaylistAccount,
  type PlaylistSnapshot,
  type PlaylistTrack,
} from "./types"
export type SyncSide = "library" | "listenbrainz"
export interface LinkedTrackMapping {
  libraryTrack: PlaylistTrack
  recordingMbid: string
  verifiedBy: "reviewed" | "provider-mbid"
}
export interface LinkedPlaylist {
  version: 1
  revision: number
  id: string
  library: PlaylistAccount
  listenbrainz: PlaylistAccount
  libraryPlaylistId: string
  listenbrainzPlaylistId: string
  enabled: boolean
  paused: boolean
  baseline: { library: PlaylistSnapshot; listenbrainz: PlaylistSnapshot }
  mappings: LinkedTrackMapping[]
  baselineHashes?: { library: string; listenbrainz: string }
  history?: SyncStep[]
  previousLibraryOwners?: PlaylistAccount[]
  lastSyncAt?: number
  lastCheckedAt?: number
  state: "ready" | "conflict" | "unknown" | "error"
  message?: string
  job?: SyncJob
}
export type SequenceOperation =
  | { kind: "append"; trackId: string }
  | { kind: "move"; from: number; to: number }
  | { kind: "delete"; index: number }
export interface SyncStep {
  id: string
  before: PlaylistSnapshot
  afterIds: string[]
  operation: SequenceOperation
  state:
    | "admitting"
    | "unknown"
    | "verified"
    | "reviewed-not-applied"
    | "reviewed-current"
  settledAt?: number
}
export interface SyncJob {
  id: string
  source: SyncSide
  sourceSnapshot: PlaylistSnapshot
  destinationSnapshot: PlaylistSnapshot
  desired: PlaylistTrack[]
  step?: SyncStep
  completedSteps: number
}
export type LinkedDecision =
  | { status: "paused" | "idle" | "retired" | "conflict"; reason?: string }
  | { status: "update"; source: SyncSide; desired: PlaylistTrack[] }
  | { status: "matching"; source: SyncSide; missing: number[]; reason: string }
/** Occurrence IDs are destination transport handles, not stable recording identity. */
export function playlistContent(snapshot: PlaylistSnapshot) {
  validateSnapshot(snapshot)
  return JSON.stringify([
    snapshot.title,
    snapshot.items.map((item) => item.track.id),
  ])
}
export async function playlistContentHash(snapshot: PlaylistSnapshot) {
  const bytes = new TextEncoder().encode(playlistContent(snapshot))
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
export function linkedOwner(
  link: LinkedPlaylist,
  library: PlaylistSnapshot,
  remote: PlaylistSnapshot
) {
  return (
    samePlaylistIdentity(link.library, library.account) &&
    samePlaylistIdentity(link.listenbrainz, remote.account) &&
    link.libraryPlaylistId === library.id &&
    link.listenbrainzPlaylistId === remote.id
  )
}
export function mapLinkedTracks(
  source: SyncSide,
  snapshot: PlaylistSnapshot,
  mappings: readonly LinkedTrackMapping[]
): { desired: PlaylistTrack[]; missing: number[] } {
  const desired: PlaylistTrack[] = [],
    missing: number[] = []
  snapshot.items.forEach((item, index) => {
    const matches = mappings.filter((mapping) =>
      source === "library"
        ? mapping.libraryTrack.id === item.track.id
        : mapping.recordingMbid === recordingMbid(item.track.recordingMbid)
    )
    const unique = new Map(
      matches.map((mapping) => [
        source === "library" ? mapping.recordingMbid : mapping.libraryTrack.id,
        mapping,
      ])
    )
    if (unique.size !== 1) {
      missing.push(index)
      return
    }
    const mapping = [...unique.values()][0]
    if (!recordingMbid(mapping.recordingMbid)) {
      missing.push(index)
      return
    }
    desired.push(
      source === "library"
        ? {
            ...item.track,
            id: mapping.recordingMbid,
            recordingMbid: mapping.recordingMbid,
          }
        : { ...mapping.libraryTrack, recordingMbid: mapping.recordingMbid }
    )
  })
  return { desired, missing }
}
export function decideLinkedSync(
  link: LinkedPlaylist,
  library: PlaylistSnapshot,
  remote: PlaylistSnapshot
): LinkedDecision {
  validateSnapshot(library)
  validateSnapshot(remote)
  if (!linkedOwner(link, library, remote))
    return {
      status: "retired",
      reason: "A linked playlist belongs to another account or library.",
    }
  if (!link.enabled || link.paused || link.job) return { status: "paused" }
  const localChanged =
      playlistContent(library) !== playlistContent(link.baseline.library),
    remoteChanged =
      playlistContent(remote) !== playlistContent(link.baseline.listenbrainz)
  if (!localChanged && !remoteChanged) return { status: "idle" }
  if (localChanged && remoteChanged)
    return {
      status: "conflict",
      reason: "Both playlists changed. Review which ordered version to keep.",
    }
  if (
    library.title !== link.baseline.library.title ||
    remote.title !== link.baseline.listenbrainz.title
  )
    return {
      status: "conflict",
      reason:
        "Playlist names changed. Review names separately before resuming track sync.",
    }
  const source: SyncSide = localChanged ? "library" : "listenbrainz",
    mapped = mapLinkedTracks(
      source,
      source === "library" ? library : remote,
      link.mappings
    )
  return mapped.missing.length
    ? {
        status: "matching",
        source,
        missing: mapped.missing,
        reason:
          "New or ambiguous occurrences require explicit recording/library matching.",
      }
    : { status: "update", source, desired: mapped.desired }
}
export function applySequenceOperation(
  before: readonly string[],
  operation: SequenceOperation
): string[] {
  const next = [...before]
  if (operation.kind === "append") {
    if (!operation.trackId || next.length >= 1000)
      throw Error("Playlist item limit reached")
    next.push(operation.trackId)
  } else if (operation.kind === "delete") {
    if (
      !Number.isInteger(operation.index) ||
      operation.index < 0 ||
      operation.index >= next.length
    )
      throw Error("Invalid occurrence")
    next.splice(operation.index, 1)
  } else {
    if (
      !Number.isInteger(operation.from) ||
      !Number.isInteger(operation.to) ||
      operation.from < 0 ||
      operation.from >= next.length ||
      operation.to < 0 ||
      operation.to >= operation.from
    )
      throw Error("Invalid move")
    const [item] = next.splice(operation.from, 1)
    next.splice(operation.to, 0, item)
  }
  return next
}
/** One verb at a time. Add before removing old songs where capacity permits. */
export function nextSequenceOperation(
  before: readonly string[],
  target: readonly string[]
): SequenceOperation | null {
  if (
    before.length > 1000 ||
    target.length > 1000 ||
    [...before, ...target].some((id) => !id || id.length > 500)
  )
    throw Error("Invalid or oversized ordered playlist")
  for (let index = 0; index < target.length; index++) {
    if (before[index] === target[index]) continue
    const found = before.indexOf(target[index], index + 1)
    if (found !== -1) return { kind: "move", from: found, to: index }
    if (before.length < 1000) return { kind: "append", trackId: target[index] }
    const counts = new Map<string, number>()
    target.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1))
    for (let i = 0; i < before.length; i++)
      counts.set(before[i], (counts.get(before[i]) ?? 0) - 1)
    for (let i = before.length - 1; i >= 0; i--)
      if ((counts.get(before[i]) ?? 0) < 0) return { kind: "delete", index: i }
    throw Error("Playlist capacity requires review")
  }
  return before.length > target.length
    ? { kind: "delete", index: before.length - 1 }
    : null
}
