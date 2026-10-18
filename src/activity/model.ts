import { counterpartPending } from "../mixedPlaylists/matching"
import {
  playlistServices,
  type MixedPlaylist,
  type Owners,
  type Service,
} from "../mixedPlaylists/model"
import { projection } from "../mixedPlaylists/reconcile"
import type { MatchingStatus } from "../matching/types"

export interface Activity {
  id: string
  label: string
  detail?: string
  busy?: boolean
  state?: "paused" | "error" | "complete" | "waiting"
  progress?: { value: number; total: number; label: string }
  action?: { label: string; href: string }
}
export interface PlaylistActivityPhase {
  kind: "checking" | "matching" | "syncing" | "details" | "listenbrainz"
  target?: Service
}
const serviceName = (service: Service) => (service === "plex" ? "Plex" : "YTM")
const count = (value: number) => value.toLocaleString()

/** Durable ownership is checked again on every account change, including local drafts. */
export function ownsPlaylistActivity(playlist: MixedPlaylist, owners: Owners) {
  return (
    Object.entries(playlist.owners).length > 0 &&
    Object.entries(playlist.owners).every(
      ([side, owner]) => owner === owners[side as Service]
    )
  )
}

export function mixedPlaylistActivity(
  playlist: MixedPlaylist,
  running: boolean,
  phase?: PlaylistActivityPhase,
  offline = false
): Activity | null {
  const services = playlistServices(playlist)
  const pending = playlist.items.filter((row) =>
    services.some((service) => counterpartPending(row, service))
  ).length
  const checked = playlist.items.length - pending
  const unsettled = !!(
    playlist.write ||
    playlist.detailsWrite ||
    playlist.artworkWrite ||
    playlist.listenbrainz?.creationPending ||
    playlist.listenbrainz?.detailsWrite
  )
  const review =
    playlist.status === "conflict" || playlist.status === "error" || unsettled
  const queued = playlist.automatic && pending > 0
  const throttled = playlist.items.some(
    (row) =>
      row.match.status === "pending" &&
      /YouTube Music (?:is rate limited|request queue is busy)\./.test(
        row.match.message ?? ""
      )
  )
  if (!running && !review && !queued) return null
  const mode = !running
    ? review
      ? "Sync needs review"
      : offline
        ? "Matching paused"
        : throttled
          ? "Waiting for YouTube Music · retries automatically"
          : "Matching queued"
    : phase?.kind === "matching"
      ? `Matching ${phase.target ? serviceName(phase.target) : "songs"}`
      : phase?.kind === "checking"
        ? "Checking recordings"
        : phase?.kind === "details"
          ? "Syncing playlist details"
          : phase?.kind === "listenbrainz"
            ? "Syncing ListenBrainz"
            : "Syncing playlist"
  return {
    id: `mixed:${playlist.id}`,
    label: playlist.title,
    detail: [
      mode,
      `${count(checked)} of ${count(playlist.items.length)} songs checked`,
      ...services.map((service) => {
        const matched = projection(playlist, service).length
        const synced = playlist.baseline[service]?.items.length ?? 0
        return `${serviceName(service)} · ${count(matched)} available · ${count(synced)} synced`
      }),
      ...(running && review && phase?.kind === "matching"
        ? ["Sync needs review in Info; matching continues."]
        : []),
    ].join("\n"),
    busy: running,
    state: running ? undefined : review || offline ? "paused" : "waiting",
    progress:
      pending || phase?.kind === "matching"
        ? {
            value: checked,
            total: playlist.items.length,
            label: "Songs checked",
          }
        : undefined,
    action: {
      label: review && !running ? "Review sync" : "Open playlist",
      href: `/mixed-playlist/${encodeURIComponent(playlist.id)}${review && !running ? "?info=sync" : ""}`,
    },
  }
}

export interface DownloadActivitySummary {
  queued: number
  downloading: number
  paused: number
  failed: number
  downloaded: number
  received: number
  total: number | null
}
export function downloadActivity(
  summary: DownloadActivitySummary,
  offline: boolean
): Activity | null {
  const pending = summary.queued + summary.downloading + summary.paused
  if (!pending && !summary.failed) return null
  const busy = !offline && summary.queued + summary.downloading > 0
  const parts = [
    `${count(summary.downloaded)} saved · ${count(pending)} remaining`,
  ]
  if (summary.downloading && summary.total)
    parts.push(
      `Current song · ${Math.min(100, Math.floor((summary.received / summary.total) * 100))}%`
    )
  if (offline && pending) parts.push("Resumes when Plex reconnects.")
  if (summary.failed)
    parts.push(
      `${count(summary.failed)} failed · review download issues on the affected playlist, album or song.`
    )
  return {
    id: "downloads",
    label: busy
      ? "Downloading music"
      : pending
        ? "Downloads paused"
        : "Downloads need attention",
    detail: parts.join("\n"),
    busy,
    state: busy ? undefined : pending ? "paused" : "error",
    action: { label: "Download settings", href: "/settings/cache" },
  }
}

export function matchingIndexActivity(
  status: MatchingStatus,
  now = Date.now()
): Activity | null {
  const tasks = status.tasks.filter((task) => task.phase !== "complete")
  const refreshing =
    status.health?.refreshes.filter((task) => task.active) ?? []
  if (
    !tasks.length &&
    !refreshing.length &&
    !status.health?.pending &&
    !status.health?.reconciliationPending
  )
    return null
  const waiting = tasks.length > 0 && tasks.every((task) => task.retryAt > now)
  const busy = !status.paused && !waiting
  return {
    id: "matching-index",
    label: "Plex matching index",
    busy,
    state: status.paused ? "paused" : waiting ? "waiting" : undefined,
    detail: [
      status.paused
        ? "Indexing paused"
        : waiting
          ? "Waiting to retry automatically"
          : "Updating recording lookup data",
      ...tasks.map(
        (task) =>
          `${task.kind === "artist" ? "Artists" : task.kind === "album" ? "Releases" : "Songs"} · ${count(task.count)}${task.total == null ? "" : ` of ${count(task.total)}`} · ${task.phase === "scan" ? "indexing" : task.phase === "verify" ? "verifying" : "reconciling"}`
      ),
      ...(refreshing.length ? ["Checking recent library changes"] : []),
    ].join("\n"),
    action: { label: "Index settings", href: "/settings/cache" },
  }
}
