import { useRef } from "react"
import { IconDownload, IconTrash } from "@tabler/icons-react"
import { useEntityDownloadStatus } from "./DownloadBadge"
import { MenuItem } from "./ContextMenuPrimitives"
import {
  createEntityDownloads,
  isDownloadEntity,
  type DownloadKind,
} from "../../offline/downloadEntities"
import {
  captureDownloadOwner,
  ownsDownloads,
  refreshDownloadStatuses,
} from "../../offline/downloadStatusStore"
import { useNotificationCenterStore } from "../../stores/notificationCenterStore"

/** A source owns its songs; removing one collection preserves shared downloads. */
export function DownloadMenuItems({
  kind,
  id,
  title,
  close,
  current,
}: {
  kind: DownloadKind
  id: string
  title: string
  close(): void
  current(): boolean
}) {
  const busy = useRef(false)
  const status = useEntityDownloadStatus(kind, id)
  const owner = captureDownloadOwner()
  if (!owner || !isDownloadEntity(kind, id)) return null
  const complete =
    status?.known && status.total > 0 && status.downloaded === status.total
  async function act(remove: boolean) {
    const captured = captureDownloadOwner()
    if (!captured || !current() || busy.current) return
    busy.current = true
    const owns = () => ownsDownloads(captured)
    const api = createEntityDownloads(captured, owns)
    close()
    try {
      if (remove) await api.remove(kind, id)
      else await api.download(kind, id)
      if (!owns()) return
      refreshDownloadStatuses()
      useNotificationCenterStore.getState().notify({
        id: `audio.download.${kind}.${id}`,
        severity: "info",
        title: remove ? "Download removed" : "Download queued",
        message: remove
          ? kind === "track"
            ? `${title} is no longer downloaded.`
            : `${title} removed. Songs used by other downloads stay saved.`
          : `${title} is downloading. Its download icon shows progress and offline availability.`,
      })
    } catch (reason) {
      if (!owns() || String(reason).includes("Download request was superseded")) return
      refreshDownloadStatuses()
      const limit = String(reason).includes(
        "Choose individual albums or a playlist with at most 10,000 tracks."
      )
      const full = String(reason).includes("The download queue is full.")
      useNotificationCenterStore.getState().notify({
        id: `audio.download.${kind}.${id}`,
        severity: "warning",
        title: remove
          ? "Could not remove download"
          : "Could not finish preparing download",
        message: remove
          ? "Try removing this download again."
          : limit
            ? "Choose individual albums or a playlist with at most 10,000 tracks."
            : full
              ? "The download queue is full. Let existing downloads finish, then retry."
              : "Queued songs will keep downloading. Reconnect to Plex and retry from this item's menu.",
      })
    } finally {
      busy.current = false
    }
  }
  return (
    <>
      {!owner.provider.isOffline &&
        (!complete || !status?.requested) &&
        !status?.pending && (
          <MenuItem
            icon={<IconDownload size={16} />}
            label={
              complete && !status?.requested
                ? `Keep this ${kind} downloaded`
                : status?.requested || status?.downloaded
                  ? "Download missing tracks"
                  : "Download for offline playback"
            }
            onClick={() => void act(false)}
          />
        )}
      {status?.requested ||
      (kind === "track" && (status?.downloaded || status?.pending)) ? (
        <MenuItem
          icon={<IconTrash size={16} />}
          label={
            status?.pending ? "Cancel and remove download" : "Remove download"
          }
          onClick={() => void act(true)}
        />
      ) : null}
    </>
  )
}
