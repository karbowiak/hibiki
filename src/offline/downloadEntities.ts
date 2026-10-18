import { invoke } from "@tauri-apps/api/core"
import type { MusicProvider } from "../providers/types"
import type { PlexRequestContext } from "../backends/plex/scopedApi"
import { beginActivity } from "../activity/store"
import { refreshNativeActivity } from "../activity/native"

export type DownloadKind = "track" | "album" | "artist" | "playlist"
export interface DownloadEntity {
  kind: DownloadKind
  id: string
}
export interface EntityDownloadStatus {
  kind: DownloadKind
  id: number
  known: boolean
  total: number
  downloaded: number
  pending: number
  failed: number
  requested: boolean
  error?: string | null
}
export interface DownloadOwner {
  provider: MusicProvider
  context: PlexRequestContext
  session: unknown
}
export interface DownloadIssue {
  trackId: number
  title: string
  artist: string
  error: string
}
export function isDownloadEntity(
  kind: string,
  id: string
): kind is DownloadKind {
  return (
    ["track", "album", "artist", "playlist"].includes(kind) &&
    /^[1-9]\d*$/.test(id) &&
    Number.isSafeInteger(Number(id))
  )
}
export function downloadLabel(
  status: EntityDownloadStatus,
  offline = false
): string | null {
  if (status.known && status.total > 0 && status.downloaded === status.total)
    return status.total === 1
      ? "Downloaded · available offline"
      : `Downloaded · ${status.total} tracks available offline`
  if (status.pending)
    return `${offline ? "Download paused" : "Downloading"} · ${status.downloaded} of ${status.total} tracks available offline`
  if (status.downloaded || status.requested)
    return `${status.downloaded} of ${status.total} tracks downloaded${status.failed ? ` · ${status.failed} need attention${status.error ? `: ${status.error}` : ""}` : ""}`
  return null
}
export function createEntityDownloads(
  owner: DownloadOwner,
  owns: () => boolean,
  transport: typeof invoke = invoke
) {
  const context = Object.freeze({ ...owner.context })
  const check = () => {
    if (
      !owns() ||
      owner.provider.cacheScope !== context.cacheScope ||
      owner.provider.playbackSession !== owner.session
    )
      throw new Error("Download request was superseded")
  }
  async function call<T>(command: string, args: Record<string, unknown>) {
    check()
    const result = await transport<T>(command, { ...args, context })
    check()
    return result
  }
  const entity = (kind: DownloadKind, id: string) => {
    if (!isDownloadEntity(kind, id)) throw new Error("Invalid download source")
    return { kind, id: Number(id) }
  }
  return {
    status: (entities: DownloadEntity[]) =>
      call<EntityDownloadStatus[]>("download_entity_status", {
        entities: entities.map((item) => entity(item.kind, item.id)),
      }),
    download: (kind: DownloadKind, id: string, title?: string) => {
      if (owner.provider.isOffline)
        return Promise.reject(
          new Error("Reconnect to Plex before downloading.")
        )
      const args = entity(kind, id)
      const activity = beginActivity({ id: `download-prepare:${context.cacheScope}:${kind}:${id}`,
        label: `Preparing ${kind} download`, detail: title ? `${title}\nReading songs from Plex` : "Reading songs from Plex", busy: true }, owns)
      return call<number>("download_entity", args).finally(() => { activity.finish(); refreshNativeActivity() })
    },
    issues: (kind: DownloadKind, id: string, offset = 0) =>
      call<{ items: DownloadIssue[]; total: number }>(
        "download_entity_issues",
        { ...entity(kind, id), offset }
      ),
    remove: (kind: DownloadKind, id: string) =>
      call<void>("remove_entity_download", entity(kind, id)).finally(refreshNativeActivity),
  }
}
