import { matchTrack, recordingMbid } from "./matching"
import {
  type PlaylistAccount,
  type PlaylistPlan,
  type PlaylistSnapshot,
  type PlaylistTrack,
  type PlaylistCapabilities,
} from "./types"
export const MAX_PLAYLIST_ITEMS = 1000
export const DUPLICATE_COPY_REASON =
  "Plex cannot preserve repeated songs when creating this copy. No playlist will be created."
export function playlistCopyBlockReason(
  plan: PlaylistPlan,
  capabilities: PlaylistCapabilities
): string | null {
  if (
    capabilities.preservesDuplicateCopies !== false ||
    plan.rows.some((row) => row.match.status !== "matched")
  )
    return null
  const ids = resolvedTracks(plan).map((track) =>
    plan.direction === "export" ? track.recordingMbid : track.id
  )
  return new Set(ids).size !== ids.length ? DUPLICATE_COPY_REASON : null
}
export function snapshotRevision(snapshot: PlaylistSnapshot): string {
  return JSON.stringify(snapshot)
}
export function validateSnapshot(snapshot: PlaylistSnapshot) {
  if (snapshot.readOnly !== undefined && typeof snapshot.readOnly !== "boolean")
    throw Error("Invalid playlist write capability")
  if (
    !snapshot.account.service ||
    !snapshot.account.user ||
    !snapshot.account.revision ||
    [
      snapshot.account.service,
      snapshot.account.user,
      snapshot.account.revision,
    ].some((value) => value.length > 500)
  )
    throw Error("Invalid playlist account")
  if (
    !snapshot.id ||
    snapshot.id.length > 500 ||
    !snapshot.title.trim() ||
    snapshot.title.length > 500 ||
    snapshot.items.length > MAX_PLAYLIST_ITEMS
  )
    throw Error("Invalid or oversized playlist")
  const occurrences = new Set<string>()
  for (const item of snapshot.items) {
    if (!item.occurrenceId || occurrences.has(item.occurrenceId))
      throw Error("Playlist occurrence identity must be unique")
    if (
      item.occurrenceId.length > 500 ||
      !item.track.id ||
      item.track.id.length > 500 ||
      [item.track.title, item.track.artist, item.track.album ?? ""].some(
        (value) => value.length > 1000
      )
    )
      throw Error("Invalid playlist track metadata")
    occurrences.add(item.occurrenceId)
  }
}
export function planPlaylistCopy(
  source: PlaylistSnapshot,
  target: PlaylistAccount,
  options: {
    direction: "import" | "export"
    candidates?: readonly PlaylistTrack[]
    title?: string
  }
): PlaylistPlan {
  validateSnapshot(source)
  const title = options.title?.trim() || source.title.trim()
  if (title.length > 500) throw Error("Playlist title is too long")
  const plan: PlaylistPlan = {
    version: 1,
    direction: options.direction,
    source,
    target,
    title,
    sourceRevision: snapshotRevision(source),
    rows: source.items.map((item) => ({
      occurrenceId: item.occurrenceId,
      source: item.track,
      match:
        options.direction === "export"
          ? recordingMbid(item.track.recordingMbid)
            ? {
                status: "matched",
                track: {
                  ...item.track,
                  recordingMbid: recordingMbid(item.track.recordingMbid),
                },
                by: "mbid",
              }
            : { status: "missing", candidates: [] }
          : matchTrack(item.track, options.candidates ?? []),
    })),
  }
  // Preview cannot be altered by later mutable provider/cache objects.
  return deepFreeze(structuredClone(plan))
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}
export function resolvedTracks(plan: PlaylistPlan): PlaylistTrack[] {
  if (plan.rows.some((row) => row.match.status !== "matched"))
    throw Error("Resolve every missing or ambiguous occurrence before copying")
  return plan.rows.map((row) =>
    row.match.status === "matched" ? row.match.track : null!
  )
}

/** Explicit per-occurrence resolution. It never discards other duplicate occurrences. */
export function resolvePlaylistOccurrence(
  plan: PlaylistPlan,
  occurrenceId: string,
  selected: PlaylistTrack
): PlaylistPlan {
  const row = plan.rows.find((row) => row.occurrenceId === occurrenceId)
  if (!row) throw Error("Playlist occurrence is no longer in this preview")
  if (
    !selected.id ||
    (plan.direction === "export" && !recordingMbid(selected.recordingMbid))
  )
    throw Error("Select a valid recording for this occurrence")
  const next: PlaylistPlan = {
    ...plan,
    rows: plan.rows.map((item) =>
      item.occurrenceId === occurrenceId
        ? {
            ...item,
            match: {
              status: "matched",
              track: {
                ...selected,
                recordingMbid: recordingMbid(selected.recordingMbid),
              },
              by: "manual",
            },
          }
        : item
    ),
  }
  return deepFreeze(structuredClone(next))
}
