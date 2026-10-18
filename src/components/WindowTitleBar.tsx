import { Button } from "./shared/Button"
import { useEffect, useState } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"

export function WindowTitleBar() {
  const [maximized, setMaximized] = useState(false)
  const win = getCurrentWindow()

  useEffect(() => {
    // Sync initial state
    void win.isMaximized().then(setMaximized)
    // Listen for resize to track maximize/restore
    const unlisten = win.onResized(() => {
      void win.isMaximized().then(setMaximized)
    })
    return () => { void unlisten.then(fn => fn()) }
  }, [])

  return (
    <div
      data-tauri-drag-region
      className="flex h-8 shrink-0 select-none items-center justify-between bg-app-bg"
    >
      {/* App label */}
      <span data-tauri-drag-region className="pl-3 text-xs font-semibold text-white/70">
        Hibiki
      </span>

      {/* Window controls */}
      <div className="flex h-full">
        {/* Minimize */}
        <Button
          variant="bare"
          onClick={() => void win.minimize()}
          className="flex h-full w-11 items-center justify-center text-white/70 hover:bg-white/10"
        >
          <svg width="10" height="1" viewBox="0 0 10 1">
            <rect width="10" height="1" fill="currentColor" />
          </svg>
        </Button>

        {/* Maximize / Restore */}
        <Button
          variant="bare"
          onClick={() => void win.toggleMaximize()}
          className="flex h-full w-11 items-center justify-center text-white/70 hover:bg-white/10"
        >
          {maximized ? (
            // Restore icon (two overlapping squares)
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                d="M3 0.5h6.5v6.5M0.5 3h6.5v6.5h-6.5z"
              />
            </svg>
          ) : (
            // Maximize icon (single square)
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </Button>

        {/* Close */}
        <Button
          variant="bare"
          onClick={() => void win.close()}
          className="flex h-full w-11 items-center justify-center text-white/70 hover:bg-red-600 hover:text-white"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path stroke="currentColor" strokeWidth="1.2" d="M1 1l8 8M9 1l-8 8" />
          </svg>
        </Button>
      </div>
    </div>
  )
}
