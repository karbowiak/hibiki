import { useEffect, useRef, useSyncExternalStore } from "react"
import { keepOpen, retryClose, shutdownSnapshot, subscribeShutdown } from "../lib/shutdown"

export function ShutdownNotice() {
  const status = useSyncExternalStore(subscribeShutdown, shutdownSnapshot, shutdownSnapshot)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (status.phase === "idle") return
    dialog.current?.focus()
    const blockBackground = (event: KeyboardEvent) => {
      if (!dialog.current?.contains(event.target as Node)) { event.preventDefault(); event.stopImmediatePropagation() }
    }
    window.addEventListener("keydown", blockBackground, true)
    return () => window.removeEventListener("keydown", blockBackground, true)
  }, [status.phase])
  if (status.phase === "idle") return null
  return <div className="fixed inset-0 z-1000 flex items-center justify-center bg-black/60 p-6" role="dialog" aria-modal="true" aria-label="Closing Hibiki">
    <div ref={dialog} tabIndex={-1} className="max-w-md rounded-lg border border-white/15 bg-app-card p-6 text-white shadow-xl">
      <h2 className="text-lg font-semibold">{status.phase === "preparing" ? "Closing Hibiki" : "Hibiki stayed open"}</h2>
      <p className="mt-3 text-sm text-white/80" role="status">{status.message}</p>
      {status.phase === "failed" && <div className="mt-5 flex gap-3">
        <button className="rounded bg-accent px-4 py-2 text-sm text-black" onClick={() => void retryClose()}>Retry and quit</button>
        <button className="rounded border border-white/20 px-4 py-2 text-sm" onClick={() => void keepOpen().catch(() => {})}>Keep open</button>
      </div>}
    </div>
  </div>
}
