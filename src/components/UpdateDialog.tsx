import { useState, useEffect } from "react"
import { useUpdateStore } from "../stores/updateStore"

export function UpdateDialog() {
  const { update, showDialog, setShowDialog, checkForUpdate } = useUpdateStore()
  const [installing, setInstalling] = useState(false)
  const [done, setDone] = useState(false)
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null }>({ downloaded: 0, total: null })

  useEffect(() => {
    // Check for updates 3 seconds after launch (silent — no error shown if no releases exist yet)
    const timer = setTimeout(() => void checkForUpdate({ silent: true }), 3000)
    return () => clearTimeout(timer)
  }, [])

  if (!update || !showDialog) return null

  const handleInstall = async () => {
    setInstalling(true)
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          setProgress((p) => ({ ...p, total: event.data.contentLength! }))
        } else if (event.event === "Progress") {
          setProgress((p) => ({ ...p, downloaded: p.downloaded + event.data.chunkLength }))
        }
      })
      // On Windows (NSIS passive), the installer handles restart automatically.
      // On macOS/Linux, prompt the user to relaunch manually.
      setDone(true)
    } catch {
      setInstalling(false)
    }
  }

  const dismiss = () => {
    setShowDialog(false)
    setInstalling(false)
    setDone(false)
    setProgress({ downloaded: 0, total: null })
  }

  const pct = progress.total ? Math.round((progress.downloaded / progress.total) * 100) : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="w-[400px] rounded-xl bg-app-surface p-7 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Update Available</h2>
          {!installing && (
            <button
              onClick={dismiss}
              className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:bg-white/10"
            >
              &#10005;
            </button>
          )}
        </div>

        {/* Body */}
        {done ? (
          <div className="py-4 text-center">
            <div className="mb-2 text-4xl">&#10003;</div>
            <p className="font-semibold text-accent">Update installed!</p>
            <p className="mt-1 text-sm text-white/50">Restart Plexify to use the new version.</p>
          </div>
        ) : (
          <>
            <p className="mb-2 text-sm text-white/70">
              Plexify <span className="font-semibold text-accent">{update.version}</span> is ready to install.
            </p>
            {update.body && (
              <p className="mb-5 max-h-32 overflow-y-auto rounded-lg bg-white/5 px-3 py-2 text-xs text-white/50">
                {update.body}
              </p>
            )}

            {/* Progress bar */}
            {installing && (
              <div className="mb-5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-300"
                    style={{ width: pct != null ? `${pct}%` : "100%" }}
                  />
                </div>
                <p className="mt-1 text-xs text-white/40">
                  {pct != null ? `Downloading\u2026 ${pct}%` : "Downloading\u2026"}
                </p>
              </div>
            )}

            {/* Actions */}
            {!installing && (
              <div className="flex justify-end gap-3">
                <button
                  onClick={dismiss}
                  className="rounded-full px-5 py-2 text-sm font-semibold text-white hover:bg-white/10"
                >
                  Later
                </button>
                <button
                  onClick={handleInstall}
                  className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-black transition-opacity hover:scale-105 active:scale-95"
                >
                  Update & Restart
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
