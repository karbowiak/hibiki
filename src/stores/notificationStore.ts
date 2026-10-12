import { create } from "zustand"
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification"
import { booleanPreference, type ScalarPreference } from "./scalarPreference"

export interface NotificationState {
  /** Existing now-playing notifications remain independently selectable. */
  notificationsEnabled: boolean
  warningNotificationsEnabled: boolean
  setNotificationsEnabled: (value: boolean) => void
  /** Explicit Settings action only. Returns false if permission was denied or superseded. */
  setWarningNotificationsEnabled: (value: boolean) => Promise<boolean>
}
interface NotificationPermissions {
  isPermissionGranted: () => Promise<boolean>
  requestPermission: () => Promise<string>
}

export function createNotificationPreferenceStore({
  trackPreference,
  warningPreference,
  permissions,
}: {
  trackPreference: ScalarPreference<boolean>
  warningPreference: ScalarPreference<boolean>
  permissions: NotificationPermissions
}) {
  let revision = 0
  let pendingPermission: Promise<boolean> | null = null
  const store = create<NotificationState>((set) => ({
    notificationsEnabled: trackPreference.snapshot(),
    warningNotificationsEnabled: warningPreference.snapshot(),
    setNotificationsEnabled: (value) => {
      trackPreference.set(value)
      set({ notificationsEnabled: value })
    },
    setWarningNotificationsEnabled: async (value) => {
      const request = ++revision
      if (!value) {
        warningPreference.set(false)
        set({ warningNotificationsEnabled: false })
        return true
      }
      // Hydration never calls this path. Permission prompts require an explicit opt-in.
      if (!pendingPermission) {
        const pending = (async () => {
          try {
            return (
              (await permissions.isPermissionGranted()) ||
              (await permissions.requestPermission()) === "granted"
            )
          } catch {
            return false
          }
        })()
        pendingPermission = pending
        void pending.finally(() => {
          if (pendingPermission === pending) pendingPermission = null
        })
      }
      const granted = await pendingPermission
      if (request !== revision || !granted) return false
      warningPreference.set(true)
      set({ warningNotificationsEnabled: true })
      return true
    },
  }))
  trackPreference.subscribe(() =>
    store.setState({ notificationsEnabled: trackPreference.snapshot() })
  )
  warningPreference.subscribe(() =>
    store.setState({
      warningNotificationsEnabled: warningPreference.snapshot(),
    })
  )
  return store
}

export const useNotificationStore = createNotificationPreferenceStore({
  trackPreference: booleanPreference("plex-notifications-enabled", true),
  warningPreference: booleanPreference(
    "plex-warning-notifications-enabled",
    false
  ),
  permissions: { isPermissionGranted, requestPermission },
})
