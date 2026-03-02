import { create } from "zustand"
import { check, type Update } from "@tauri-apps/plugin-updater"

interface UpdateState {
  update: Update | null
  checking: boolean
  error: string | null
  showDialog: boolean
  lastChecked: number | null

  /** Run the update check. Pass silent=true for the auto-check on launch (suppresses errors). */
  checkForUpdate: (opts?: { silent?: boolean }) => Promise<void>
  setShowDialog: (show: boolean) => void
}

function friendlyError(err: unknown): string {
  const msg = String(err)
  if (msg.includes("Could not fetch") || msg.includes("latest.json"))
    return "No update info published yet. Updates will work once a new release is built."
  if (msg.includes("network") || msg.includes("fetch"))
    return "Could not reach the update server. Check your internet connection."
  return msg
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  update: null,
  checking: false,
  error: null,
  showDialog: false,
  lastChecked: null,

  checkForUpdate: async (opts) => {
    if (get().checking) return
    // Skip update checks entirely in dev mode unless explicitly forced
    if (import.meta.env.DEV && opts?.silent) return
    set({ checking: true, error: null })
    try {
      const result = await check()
      if (result) {
        set({ update: result, showDialog: true, lastChecked: Date.now() })
      } else {
        set({ update: null, lastChecked: Date.now() })
      }
    } catch (err) {
      if (!opts?.silent) {
        set({ error: friendlyError(err) })
      }
    } finally {
      set({ checking: false })
    }
  },

  setShowDialog: (show) => set({ showDialog: show }),
}))
