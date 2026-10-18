import { counterpartPending } from "../mixedPlaylists/matching"
import {
  mixedWriteCanRecover,
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
  kind: "preparing" | "checking" | "matching" | "syncing" | "details" | "listenbrainz"
  target?: Service
  syncing?: boolean
}
export interface BackgroundQueueJob {
  id: string
  label: string
  queue: string
  activityId?: string | null
  state: "pending" | "processing" | "scheduled"
  progress?: {
    stage: string
    current?: string | null
    completed: number
    total?: number | null
    unit: string
  } | null
}
export interface BackgroundQueueStatus {
  pending: number
  running: number
  scheduled: number
  failed: number
  jobs?: BackgroundQueueJob[]
}
export function backgroundJobActivities(
  status: BackgroundQueueStatus
): Activity[] {
  if (!status.jobs?.length) {
    const summary = backgroundQueueActivity(status)
    return summary ? [summary] : []
  }
  const grouped = new Map<string, BackgroundQueueJob[]>()
  for (const job of status.jobs) {
    const id = job.activityId ?? `job:${job.id}`
    grouped.set(id, [...(grouped.get(id) ?? []), job])
  }
  return [...grouped].map(([id, jobs]) => {
    const job = jobs.find((job) => job.state === "processing") ?? jobs[0]
    const running = job.state === "processing",
      progress = job.progress
    const valid =
      progress?.total != null &&
      progress.total > 0 &&
      Number.isFinite(progress.total) &&
      Number.isFinite(progress.completed)
    return {
      id,
      label: job.label,
      busy: running,
      state: running ? undefined : "waiting",
      detail: [
        running
          ? progress?.stage || "Starting"
          : job.state === "scheduled"
            ? "Scheduled for later"
            : "Queued",
        progress?.current,
        progress && (valid || progress.completed > 0)
          ? `${progress.completed.toLocaleString()}${valid ? ` of ${progress.total!.toLocaleString()}` : ""} ${progress.unit}`
          : "",
        jobs.length > 1 ? `${jobs.length - 1} more queued` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      progress: valid
        ? {
            value: Math.min(progress.completed, progress.total!),
            total: progress.total!,
            label: progress.unit,
          }
        : undefined,
    } satisfies Activity
  })
}

/** Domain rows carry names, review state and navigation. Queue rows add capacity
 * and progress to that same operation instead of rendering a second report. */
export function combineBackgroundActivities(
  domain: Activity[],
  queued: Activity[]
): Activity[] {
  const rows = new Map(domain.map((row) => [row.id, row]))
  for (const job of queued) {
    const row = rows.get(job.id)
    if (!row) {
      rows.set(job.id, job)
      continue
    }
    const review = row.state === "paused" || row.state === "error"
    rows.set(row.id, {
      ...job,
      ...row,
      busy: review ? row.busy : row.busy || job.busy,
      state: review || row.busy ? row.state : job.state,
      detail: row.detail || job.detail,
      progress: row.progress ?? job.progress,
    })
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))
}
/** Queue totals describe execution capacity; playlist/download rows retain the
 * useful per-item progress. Finished/dead jobs stay in diagnostics, not alerts. */
export function backgroundQueueActivity(
  status: BackgroundQueueStatus
): Activity | null {
  if (!status.running && !status.pending && !status.scheduled) return null
  return {
    id: "background-queue",
    label: "Background jobs",
    busy: status.running > 0,
    state: status.running ? undefined : "waiting",
    detail: [
      status.running ? `${status.running.toLocaleString()} running` : "",
      status.pending ? `${status.pending.toLocaleString()} queued` : "",
      status.scheduled
        ? `${status.scheduled.toLocaleString()} scheduled for later`
        : "",
    ]
      .filter(Boolean)
      .join(" · "),
  }
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
  const recovering = mixedWriteCanRecover(playlist)
  const review = !recovering && (
    playlist.status === "conflict" || playlist.status === "error" || unsettled
  )
  const queued = recovering || playlist.automatic && (pending > 0 || !!playlist.merge?.pending)
  const throttled = playlist.items.some(
    (row) =>
      row.match.status === "pending" &&
      /YouTube Music (?:is rate limited|request queue is busy)\./.test(
        row.match.message ?? ""
      )
  )
  if (!running && !review && !queued) return null
  const mode = !running
    ? recovering
      ? offline ? "Verification paused · waiting for connection" : "Verifying playlist changes · retries automatically"
      : review
      ? playlist.write
        ? "Waiting for playlist write verification"
        : "Sync needs review"
      : offline
        ? "Matching paused"
        : throttled
          ? "Waiting for YouTube Music · retries automatically"
          : playlist.merge?.pending ? "Preparing merge queued" : "Matching queued"
    : phase?.kind === "preparing"
      ? "Preparing source playlists"
      : phase?.kind === "matching"
      ? `Matching ${phase.target ? serviceName(phase.target) : "songs"}${phase.syncing ? " · syncing verified songs" : ""}`
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
  // Saved notification/catch-up hints are scheduled work, not a running index.
  // A claimed worker supplies its own queue activity while applying them.
  if (!tasks.length && !refreshing.length)
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
