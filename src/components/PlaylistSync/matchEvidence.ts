import type { PlaylistPlan } from "../../playlistSync/types"
import type { LinkedTrackMapping, SyncSide } from "../../playlistSync/linked"
import { recordingMbid } from "../../playlistSync/matching"
/** Saved link IDs are mapping keys; they must not upgrade metadata evidence into provider proof. */
export function linkedMatchEvidenceLabel(
  row: PlaylistPlan["rows"][number],
  source: SyncSide,
  mappings: readonly LinkedTrackMapping[]
): string | undefined {
  if (row.match.status !== "matched" || row.match.by !== "mbid")
    return undefined
  const libraryId = source === "library" ? row.source.id : row.match.track.id
  const mbid = recordingMbid(
    source === "library"
      ? row.match.track.recordingMbid
      : row.source.recordingMbid
  )
  let matches = mappings.filter(
    (mapping) =>
      mapping.libraryTrack.id === libraryId &&
      mapping.recordingMbid === mbid &&
      (!mapping.sourceOccurrenceId ||
        mapping.sourceOccurrenceId === row.occurrenceId)
  )
  if (
    source === "listenbrainz" &&
    matches.some((mapping) => mapping.sourceOccurrenceId === row.occurrenceId)
  )
    matches = matches.filter(
      (mapping) => mapping.sourceOccurrenceId === row.occurrenceId
    )
  const evidence = new Set(matches.map((mapping) => mapping.verifiedBy))
  if (!evidence.size) return undefined
  if (evidence.has("reviewed")) return "Saved choice"
  if (evidence.has("metadata")) return "Matched by metadata"
  return "Verified recording match"
}
