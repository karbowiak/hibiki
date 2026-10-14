import type { NotificationInput } from "../stores/notificationCenterStore"
import { isCompletedPartialMatch, type LinkedPlaylist } from "./linked"

/** Only settled results and actual interruptions get notices; progress stays in Sync. */
export function matchingResultNotice(
  link: LinkedPlaylist,
  checkedError = false
): NotificationInput | undefined {
  const progress = link.incomplete
  if (!progress || !link.enabled || link.pauseReason === "manual") return
  const completed = isCompletedPartialMatch(link)
  const blocked =
    (!completed && link.paused) ||
    link.state === "error" ||
    link.state === "unknown" ||
    (!completed && link.state === "conflict") ||
    checkedError
  if (!blocked && !completed) return
  const missing = progress.missingOccurrenceIds.length
  return {
    id: `playlist.matching.${link.id}`,
    eventKey: JSON.stringify([
      link.library,
      link.listenbrainz.user,
      progress.sourceSnapshot.id,
      progress.sourceSnapshot.items.map((item) => [
        item.occurrenceId,
        item.track.id,
      ]),
      blocked ? link.state : "completed",
      checkedError,
      link.job?.step?.id ?? link.job?.descriptionStep?.id,
      progress.matchedCount,
      progress.missingOccurrenceIds,
      progress.lookupLimits ?? [],
    ]),
    title: blocked ? "Playlist sync needs attention" : "Playlist matches saved",
    message: blocked
      ? "Open this playlist's Sync review to retry unavailable lookups or inspect a retained update. Every source song is still retained."
      : `${progress.matchedCount} of ${progress.total} songs matched. ${missing} ${missing === 1 ? "song remains" : "songs remain"} in Sync review; you can listen to the matched songs.`,
    severity: blocked ? "warning" : "info",
    persistent: false,
  }
}
const RECEIPTS = "hibiki-playlist-matching-notices-v1"
type ReceiptStorage = Pick<Storage, "getItem" | "setItem">
/** Store only hashes of completed outcomes, separately from sync revisions and source manifests. */
export function createMatchingNoticeReceipts(
  getStorage: () => ReceiptStorage | undefined
) {
  return async (eventKey: string, current: () => boolean): Promise<boolean> => {
    try {
      const bytes = new TextEncoder().encode(eventKey)
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
      if (!current()) return false
      const storage = getStorage()
      const raw: unknown = JSON.parse(storage?.getItem(RECEIPTS) ?? "[]")
      const previous = Array.isArray(raw)
        ? raw.filter(
            (value): value is string =>
              typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
          )
        : []
      if (previous.includes(hash)) return false
      storage?.setItem(
        RECEIPTS,
        JSON.stringify([...previous, hash].slice(-512))
      )
      return true
    } catch {
      // Notice storage never blocks matching. Session event deduplication remains available.
      return current()
    }
  }
}
export const claimMatchingNotice = createMatchingNoticeReceipts(() =>
  typeof localStorage === "undefined" ? undefined : localStorage
)
