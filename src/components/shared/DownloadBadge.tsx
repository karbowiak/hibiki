import { useEffect } from "react"
import {
  IconDownload,
  IconLoader2,
  IconAlertCircle,
  IconCircleDashed,
  IconPlayerPause,
} from "@tabler/icons-react"
import { useProviderStore } from "../../stores/providerStore"
import { useCatalogueStore } from "../../offline/catalogueStore"
import {
  captureDownloadOwner,
  registerDownloadStatus,
  useDownloadStatusStore,
} from "../../offline/downloadStatusStore"
import {
  isDownloadEntity,
  downloadLabel,
  type DownloadKind,
} from "../../offline/downloadEntities"

export function useEntityDownloadStatus(kind: DownloadKind, id: string) {
  const provider = useProviderStore((state) => state.provider)
  const context = useCatalogueStore((state) => state.context)
  const status = useDownloadStatusStore(
    (state) => state.statuses[`${kind}:${id}`]
  )
  useEffect(() => {
    const owner = captureDownloadOwner()
    if (!owner || !isDownloadEntity(kind, id)) return
    return registerDownloadStatus(owner, { kind, id })
  }, [provider, context?.connectionRevision, context?.cacheScope, kind, id])
  return status
}
export function DownloadBadge({
  kind,
  id,
  className = "",
  intentOnly = false,
}: {
  kind: DownloadKind
  id: string
  intentOnly?: boolean
  className?: string
}) {
  const offline = useProviderStore((state) => state.provider?.isOffline)
  const status = useEntityDownloadStatus(kind, id),
    label = status ? downloadLabel(status, offline) : null
  if (!status || !label || (intentOnly && !status.requested)) return null
  const Icon = intentOnly
    ? IconDownload
    : status.pending
      ? offline
        ? IconPlayerPause
        : IconLoader2
      : status.failed && status.downloaded < status.total
        ? IconAlertCircle
        : status.known && status.total > 0 && status.downloaded === status.total
          ? IconDownload
          : IconCircleDashed
  return (
    <span
      title={intentOnly ? "Saved for offline listening" : label}
      aria-label={intentOnly ? "Saved for offline listening" : label}
      role="img"
      className={`inline-flex shrink-0 items-center justify-center text-[var(--text-primary)] ${className}`}
    >
      <Icon
        aria-hidden="true"
        size={16}
        className={
          !intentOnly && status.pending && !offline ? "animate-spin" : ""
        }
      />
    </span>
  )
}
