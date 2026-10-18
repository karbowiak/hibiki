import { createStore, get, update } from "../storage/clientStorage"
import {
  samePlaylistIdentity,
  sameAccount,
  type PlaylistAttempt,
  type PlaylistAttemptJournal,
} from "./types"
const KEY = "attempts-v1"
let database: ReturnType<typeof createStore> | undefined
export function playlistJournalDatabase() {
  return (database ??= createStore("hibiki-playlist-sync", "attempts"))
}
/** Only token-free receipts are retained. Unknown outcomes are never automatically evicted or retried. */
export const playlistAttemptJournal: PlaylistAttemptJournal = {
  list: async () =>
    (await get<PlaylistAttempt[]>(KEY, playlistJournalDatabase())) ?? [],
  save: async (attempt) => {
    await update<PlaylistAttempt[]>(
      KEY,
      (previous) => {
        return mergePlaylistAttempt(previous ?? [], attempt)
      },
      playlistJournalDatabase()
    )
  },
}

/** Pure transaction reducer, shared by the real SQLite journal and synthetic tests. */
export function mergePlaylistAttempt(
  previous: PlaylistAttempt[],
  attempt: PlaylistAttempt
): PlaylistAttempt[] {
  const items = previous
  const existing = items.find((item) => item.id === attempt.id)
  if (
    existing &&
    ((existing.state === "verified" && attempt.state !== "verified") ||
      (existing.state === "cancelled" && attempt.state !== "cancelled"))
  )
    throw Error("This playlist attempt is already settled")
  if (
    existing?.destinationId &&
    attempt.destinationId !== existing.destinationId
  )
    throw Error("Playlist receipt destination changed")
  if (existing && !sameAccount(existing.account, attempt.account))
    throw Error("Playlist attempt account changed")
  if (
    existing?.state === "dismissed" &&
    attempt.state !== "dismissed" &&
    attempt.state !== "verified" &&
    !(attempt.state === "created" && attempt.destinationId)
  )
    throw Error("This unknown receipt was already dismissed locally")
  const unresolved = items.filter(
    (item) =>
      item.state !== "verified" &&
      item.state !== "cancelled" &&
      item.state !== "dismissed"
  )
  if (
    !existing &&
    unresolved.some(
      (item) =>
        samePlaylistIdentity(item.account, attempt.account) &&
        samePlaylistIdentity(item.sourceAccount, attempt.sourceAccount) &&
        item.sourcePlaylistId === attempt.sourcePlaylistId &&
        item.title === attempt.title &&
        JSON.stringify(item.expectedTrackIds) ===
          JSON.stringify(attempt.expectedTrackIds)
    )
  )
    throw Error(
      "Review the previous copy outcome before creating this playlist again"
    )
  if (!existing && unresolved.length >= 64)
    throw Error("Review unresolved playlist copies before creating more")
  const next = [
    ...items.filter((item) => item.id !== attempt.id),
    structuredClone({
      ...existing,
      ...attempt,
      ...(existing?.dismissedAt
        ? {
            dismissedAt: existing.dismissedAt,
            dismissalReason: existing.dismissalReason,
            reviewedAccount: existing.reviewedAccount,
          }
        : {}),
    }),
  ]
  const verified = next
    .filter(
      (item) =>
        item.state === "verified" ||
        item.state === "cancelled" ||
        item.state === "dismissed"
    )
    .slice(-32)
  return [
    ...next.filter(
      (item) =>
        item.state !== "verified" &&
        item.state !== "cancelled" &&
        item.state !== "dismissed"
    ),
    ...verified,
  ]
}
