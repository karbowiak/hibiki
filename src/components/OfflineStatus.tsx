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
      message: offline ? "Saved pages and complete cached/downloaded music are available. Reconnect to refresh metadata, download more music, or change your library."
        : `Plex could not refresh ${count === 1 ? "a page" : "some pages"}, so Hibiki is showing a saved copy${Number.isFinite(latest) ? ` from ${new Date(latest).toLocaleString()}` : ""}.`,
      severity: "info", persistent: true, action: { label: "Connection settings", run: () => navigate("/settings") } })
  }, [scope, offline, count, reads, navigate])
  return null
}

export function PlexOfflineBanner() {
  const offline = useOfflineStatusStore(s => s.offlineMode)
  const [, navigate] = useLocation()
  if (!offline) return null
  return <aside role="status" className="relative z-10 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-amber-300/25 bg-amber-950/90 px-6 py-4 text-amber-50">
    <div><p className="font-semibold">Plex is unavailable</p><p className="mt-1 text-sm text-amber-100/90">Browse your saved library and play complete cached or downloaded music. Library and playlist changes are disabled until you reconnect.</p></div>
    <button type="button" onClick={() => navigate("/settings/plex")} className="shrink-0 rounded-lg border border-amber-200/30 px-3 py-2 text-sm font-medium transition-colors hover:bg-amber-100/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200">Reconnect</button>
  </aside>
}
