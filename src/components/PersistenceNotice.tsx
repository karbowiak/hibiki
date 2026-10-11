import { useState, useSyncExternalStore } from "react"
import { IconAlertTriangle } from "@tabler/icons-react"
import { preferencePersistence } from "../stores/idbStorage"
import { localPreferencePersistence } from "../stores/localPreferenceStorage"
import type { PersistenceIssue } from "../stores/preferencePersistence"

function savedDataLabel(key: string): string {
  if (key === "radio-stream-v1") return "radio favorites and history"
  if (key === "podcast-store-v1") return "podcast subscriptions and progress"
  if (key === "metadata-source-priority-v1") return "metadata preferences"
  if (key === "plex-audio-settings-v1") return "audio preferences"
  return "metadata cache"
}

export function PersistenceNotice({
  issues,
  onRetry,
}: {
  issues: PersistenceIssue[]
  onRetry: () => Promise<void>
}) {
  const [retrying, setRetrying] = useState(false)
  if (!issues.length) return null
  const labels = [
    ...new Set(issues.map((issue) => savedDataLabel(issue.key))),
  ].join(", ")
  const message = issues.some((issue) => issue.operation === "read")
    ? "Saved data could not be loaded. Your existing saved data is protected."
    : issues.some((issue) => issue.operation === "remove")
      ? "The cache could not be cleared. Hibiki will retry when you choose Retry."
      : "Changes are kept in this session but could not be saved. Retry before closing Hibiki."
  const pendingRead = issues.some(
    (issue) => issue.operation === "read" && issue.hasPendingChanges
  )
  const retry = async () => {
    setRetrying(true)
    try {
      await onRetry()
    } catch {
      /* Keep the notice available for another retry. */
    } finally {
      setRetrying(false)
    }
  }
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100"
    >
      <IconAlertTriangle size={20} aria-hidden="true" className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Storage needs attention</p>
        <p className="mt-0.5 text-xs leading-relaxed text-amber-100/80">
          {message}{" "}
          {pendingRead &&
            "New changes stay in this session until storage recovers."}{" "}
          Affected: {labels}.
        </p>
      </div>
      <button
        type="button"
        disabled={retrying}
        onClick={() => void retry()}
        className="shrink-0 rounded-md border border-amber-200/30 px-3 py-1.5 font-medium hover:bg-amber-200/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200 disabled:opacity-50"
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  )
}

let lastIdb: PersistenceIssue[] | undefined
let lastLocal: PersistenceIssue[] | undefined
let combined: PersistenceIssue[] = []
function storageSnapshot() {
  const idb = preferencePersistence.snapshot()
  const local = localPreferencePersistence.snapshot()
  if (idb !== lastIdb || local !== lastLocal) {
    lastIdb = idb
    lastLocal = local
    combined = [...idb, ...local]
  }
  return combined
}
function subscribeStorage(callback: () => void) {
  const idb = preferencePersistence.subscribe(callback)
  const local = localPreferencePersistence.subscribe(callback)
  return () => {
    idb()
    local()
  }
}

export function StorageStatus() {
  const issues = useSyncExternalStore(
    subscribeStorage,
    storageSnapshot,
    storageSnapshot
  )
  return (
    <PersistenceNotice
      issues={issues}
      onRetry={async () => {
        await Promise.all([
          preferencePersistence.retry(),
          localPreferencePersistence.retry(),
        ])
      }}
    />
  )
}
