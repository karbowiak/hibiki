import { snapshotRevision } from "./planner"
import { sameAccount, type PlaylistSnapshot } from "./types"
export interface PlaylistLinkBaseline {
  source: PlaylistSnapshot
  destination: PlaylistSnapshot
}
/** Informational only: copy operations never silently merge or overwrite linked playlists. */
export function playlistLinkChanges(
  baseline: PlaylistLinkBaseline,
  source: PlaylistSnapshot,
  destination: PlaylistSnapshot
):
  | "unchanged"
  | "source-changed"
  | "destination-changed"
  | "both-changed"
  | "retired" {
  if (
    !sameAccount(baseline.source.account, source.account) ||
    !sameAccount(baseline.destination.account, destination.account) ||
    baseline.source.id !== source.id ||
    baseline.destination.id !== destination.id
  )
    return "retired"
  const left = snapshotRevision(baseline.source) !== snapshotRevision(source),
    right =
      snapshotRevision(baseline.destination) !== snapshotRevision(destination)
  return left && right
    ? "both-changed"
    : left
      ? "source-changed"
      : right
        ? "destination-changed"
        : "unchanged"
}
