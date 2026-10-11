import { useEffect, useState } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"

/** A blurred window can still be visible; only hidden/minimized windows stop drawing. */
export function useVisualizationVisibility(): boolean {
  const [pageVisible, setPageVisible] = useState(() => !document.hidden)
  const [minimized, setMinimized] = useState(false)
  useEffect(() => {
    const updatePage = () => setPageVisible(!document.hidden)
    document.addEventListener("visibilitychange", updatePage)
    let active = true
    let revision = 0
    const unlisteners: (() => void)[] = []
    if (isTauri()) {
      const win = getCurrentWindow()
      const updateWindow = () => {
        const request = ++revision
        void win
          .isMinimized()
          .then((value) => {
            if (active && revision === request) setMinimized(value)
          })
          .catch(() => {})
      }
      updateWindow()
      for (const register of [
        () => win.onResized(updateWindow),
        () => win.onFocusChanged(updateWindow),
      ]) {
        void register()
          .then((unlisten) => {
            if (active) unlisteners.push(unlisten)
            else unlisten()
          })
          .catch(() => {})
      }
    }
    return () => {
      active = false
      document.removeEventListener("visibilitychange", updatePage)
      unlisteners.forEach((unlisten) => unlisten())
    }
  }, [])
  return pageVisible && !minimized
}
