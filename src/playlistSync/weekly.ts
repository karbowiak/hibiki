import type { PlaylistAccount, PlaylistSnapshot } from "./types"
import { samePlaylistIdentity } from "./types"
export type WeeklyFamily = "weekly-exploration" | "weekly-jams"
/** Produced only by the verified created-for recommendation parser, never a title-only guess. */
export interface WeeklyMetadata {
  family: WeeklyFamily
  recipient: string
  weekOf: string | null
  createdAt: string
}
export interface WeeklyEdition extends WeeklyMetadata {
  playlistId: string
}
export interface WeeklyEditionReceipt {
  edition: WeeklyEdition
  sourceHash: string
  syncedAt?: number
  finishedAt?: number
  total?: number
  matchedCount?: number
  missingOccurrences?: PlaylistSnapshot["items"]
}
export interface WeeklySourceBinding {
  family: WeeklyFamily
  recipient: string
  edition: WeeklyEdition
  lastSyncedEditionId?: string
  previousEditions?: WeeklyEditionReceipt[]
  pendingSourceSnapshot?: PlaylistSnapshot
}
export interface WeeklySummary extends PlaylistSnapshot {
  weekly?: WeeklyMetadata
  access: {
    origins: string[]
    creator: string | null
    generated: boolean
    writable: boolean
  }
}
export interface WeeklyChannel {
  family: WeeklyFamily
  label: string
  status: "ready" | "ambiguous" | "unavailable"
  latest: WeeklyEdition | null
  editions: WeeklyEdition[]
}
function createdStamp(value: string): bigint {
  const seconds = BigInt(Math.floor(Date.parse(value) / 1000))
  const fraction = value.match(/\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? ""
  return (
    seconds * BigInt(1_000_000_000) + BigInt(fraction.padEnd(9, "0") || "0")
  )
}
export const newerWeeklyEdition = (a: WeeklyEdition, b: WeeklyEdition) =>
  createdStamp(a.createdAt) > createdStamp(b.createdAt)
export function validWeeklyEdition(
  edition: WeeklyEdition,
  account: PlaylistAccount
): boolean {
  if (
    !["weekly-exploration", "weekly-jams"].includes(edition.family) ||
    edition.recipient !== account.user ||
    account.service !== "listenbrainz" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      edition.playlistId
    ) ||
    (edition.weekOf !== null && !/^\d{4}-\d{2}-\d{2}$/.test(edition.weekOf)) ||
    edition.createdAt.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      edition.createdAt
    ) ||
    !Number.isFinite(Date.parse(edition.createdAt))
  )
    return false
  if (edition.weekOf === null) return true
  const week = new Date(`${edition.weekOf}T00:00:00Z`)
  return (
    Number.isFinite(week.getTime()) &&
    week.toISOString().slice(0, 10) === edition.weekOf &&
    week.getUTCDay() === 1
  )
}
/** No title deduplication: same-week distinct IDs remain candidates until a unique timestamp wins. */
export function weeklySourceChannels(
  listing: { items: readonly WeeklySummary[]; complete: boolean },
  expected: PlaylistAccount
): WeeklyChannel[] {
  if (listing.items.length > 2000)
    throw Error("Weekly feed is too large to review safely")
  return (["weekly-exploration", "weekly-jams"] as const).map((family) => {
    const editions = new Map<string, WeeklyEdition>()
    let conflicting = false
    for (const summary of listing.items) {
      if (
        !summary.weekly ||
        summary.weekly.family !== family ||
        !samePlaylistIdentity(summary.account, expected) ||
        !summary.access.generated ||
        summary.access.writable ||
        summary.access.creator !== "listenbrainz" ||
        !summary.access.origins.includes("createdfor")
      )
        continue
      const edition: WeeklyEdition = {
        ...summary.weekly,
        playlistId: summary.id,
      }
      if (!validWeeklyEdition(edition, expected)) continue
      const old = editions.get(edition.playlistId)
      if (old && JSON.stringify(old) !== JSON.stringify(edition))
        conflicting = true
      editions.set(edition.playlistId, edition)
    }
    const ordered = [...editions.values()].sort((a, b) =>
      createdStamp(a.createdAt) === createdStamp(b.createdAt)
        ? 0
        : createdStamp(a.createdAt) > createdStamp(b.createdAt)
          ? -1
          : 1
    )
    const first = ordered[0],
      tied = first
        ? ordered.filter(
            (edition) =>
              createdStamp(edition.createdAt) === createdStamp(first.createdAt)
          )
        : []
    const ready = listing.complete && !conflicting && tied.length === 1
    return {
      family,
      label:
        family === "weekly-exploration" ? "Weekly Exploration" : "Weekly Jams",
      status: ready ? "ready" : ordered.length ? "ambiguous" : "unavailable",
      latest: ready ? first : null,
      editions: ordered,
    }
  })
}
export function weeklySourceDescription(edition: WeeklyEdition): string {
  return `${edition.family === "weekly-exploration" ? "Weekly Exploration" : "Weekly Jams"} · ${edition.weekOf ? `week of ${edition.weekOf}` : `generated ${edition.createdAt.slice(0, 10)}`}.`
}

export class WeeklyArchiveCapacityError extends Error {
  constructor() {
    super(
      "Weekly review history contains 32 unresolved editions. Review the retained missing songs before following another edition; the current playlist and source are unchanged."
    )
  }
}
export function retainWeeklyHistory(
  rows: WeeklyEditionReceipt[]
): WeeklyEditionReceipt[] {
  const pending = rows.filter((receipt) => !!receipt.missingOccurrences?.length)
  if (pending.length > 32) throw new WeeklyArchiveCapacityError()
  const settled = rows
    .filter((receipt) => !receipt.missingOccurrences?.length)
    .slice(-(32 - pending.length))
  const keep = new Set(pending.concat(pending.length === 32 ? [] : settled))
  return rows.filter((receipt) => keep.has(receipt))
}
