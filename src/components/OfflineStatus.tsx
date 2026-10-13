import { useEffect } from "react"
import { useLocation } from "wouter"
import { useOfflineStatusStore } from "../offline/statusStore"
import { useNotificationCenterStore } from "../stores/notificationCenterStore"

/** Saved reads share the app's notification center, without another error banner. */
export function OfflineStatus() {
  const scope = useOfflineStatusStore(s => s.scope)
  const offline = useOfflineStatusStore(s => s.offlineMode)
  const reads = useOfflineStatusStore(s => s.savedReads)
  const [, navigate] = useLocation()
  const count = Object.keys(reads).length
  useEffect(() => {
    const notices = useNotificationCenterStore.getState()
    if (!scope || (!offline && !count)) { notices.resolve("library.saved"); return }
    const latest = Math.max(...Object.values(reads))
    notices.notify({ id: "library.saved", title: offline ? "Browsing your saved library" : "Showing saved library pages",
      message: offline ? "Previously visited pages are available. Reconnect to play music, refresh metadata, or change your library."
        : `Plex could not refresh ${count === 1 ? "a page" : "some pages"}, so Hibiki is showing a saved copy${Number.isFinite(latest) ? ` from ${new Date(latest).toLocaleString()}` : ""}.`,
      severity: "info", persistent: true, action: { label: "Connection settings", run: () => navigate("/settings") } })
  }, [scope, offline, count, reads, navigate])
  return null
}
