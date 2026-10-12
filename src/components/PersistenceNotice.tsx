import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"
import { preferencePersistence } from "../stores/idbStorage"
import { localPreferencePersistence } from "../stores/localPreferenceStorage"
import { useNotificationCenterStore } from "../stores/notificationCenterStore"
import type { PersistenceIssue } from "../stores/preferencePersistence"

function savedDataLabel(key: string): string {
  const labels: Record<string, string> = {
    "radio-stream-v1": "radio favorites and history",
    "podcast-store-v1": "podcast subscriptions and progress",
    "metadata-source-priority-v1": "metadata preferences",
    "plex-audio-settings-v1": "audio preferences",
    "plex-player-prefs": "playback preferences",
    "plex-lyrics-offsets": "lyrics timing",
    "plex-visualizer-v1": "visualizer preferences",
    "plex-sleep-timer-v1": "sleep timer preferences",
    "plex-custom-colors": "color preferences",
    "easter-eggs-v1": "extra effects preferences",
    "plex-accent-color": "accent color",
    "plex-debug-enabled": "debug preferences",
    "plex-notifications-enabled": "notification preferences",
    "plex-warning-notifications-enabled": "notification preferences",
  }
  if (labels[key]) return labels[key]
  if (
    /^(deezer|itunes|musicbrainz|lastfm)-(metadata|mbid-cache)-v\d+$/.test(key)
  )
    return "metadata cache"
  return "saved preferences"
}

/** The issue owner controls recovery; unmounting never pretends data was saved. */
export function PersistenceNotice({
  issues,
  onRetry,
}: {
  issues: PersistenceIssue[]
  onRetry: () => Promise<void>
}) {
  const notify = useNotificationCenterStore((s) => s.notify)
  const resolve = useNotificationCenterStore((s) => s.resolve)
  const mounted = useRef(false)
  const retrying = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const retry = useCallback(async () => {
    if (!mounted.current || retrying.current) return
    retrying.current = true
    try {
      await onRetry()
    } catch {
      throw new Error(
        "Storage could not recover. Your changes remain in this session; please try again."
      )
    } finally {
      retrying.current = false
    }
  }, [onRetry])
  useEffect(() => {
    if (!issues.length) {
      resolve("storage.preferences")
      return
    }
    const labels = [
      ...new Set(issues.map((issue) => savedDataLabel(issue.key))),
    ].join(", ")
    const reading = issues.some((issue) => issue.operation === "read")
    const writing = issues.some((issue) => issue.operation === "write")
    const removing = issues.some((issue) => issue.operation === "remove")
    const unsaved = writing || issues.some((issue) => issue.hasPendingChanges)
    const messages: string[] = []
    if (reading)
      messages.push(
        "Saved data could not be loaded. Your existing saved data is protected."
      )
    if (writing)
      messages.push("Changes are kept in this session but could not be saved.")
    if (
      issues.some(
        (issue) => issue.operation === "read" && issue.hasPendingChanges
      )
    ) {
      messages.push("New changes stay in this session until storage recovers.")
    }
    if (removing)
      messages.push(
        "Saved data could not be cleared. Retry to finish clearing it."
      )
    if (unsaved) messages.push("Retry before closing Hibiki.")
    messages.push(`Affected: ${labels}.`)
    notify({
      id: "storage.preferences",
      title: "Storage needs attention",
      message: messages.join(" "),
      severity: unsaved ? "error" : "warning",
      persistent: true,
      action: { label: "Retry", run: retry },
    })
  }, [issues, notify, resolve, retry])
  return null
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
        const results = await Promise.allSettled([
          preferencePersistence.retry(),
          localPreferencePersistence.retry(),
        ])
        if (results.some((result) => result.status === "rejected")) {
          throw new Error("Storage recovery is incomplete")
        }
      }}
    />
  )
}
