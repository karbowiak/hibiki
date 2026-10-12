import {
  isPermissionGranted,
  sendNotification,
} from "@tauri-apps/plugin-notification"
import {
  useNotificationCenterStore,
  type AppNotification,
  type NotificationCenterState,
} from "../stores/notificationCenterStore"
import { useNotificationStore } from "../stores/notificationStore"

/** Permission requests belong to the explicit Settings opt-in, never background reports. */
export function connectSystemNotifications({
  store = useNotificationCenterStore,
  enabled = () => useNotificationStore.getState().warningNotificationsEnabled,
  background = () =>
    document.visibilityState === "hidden" || !document.hasFocus(),
  permission = isPermissionGranted,
  send = (notification: AppNotification) =>
    sendNotification({
      title: `Hibiki · ${notification.title}`,
      body: notification.message,
    }),
}: {
  store?: {
    getState: () => NotificationCenterState
    subscribe: (
      listener: (
        state: NotificationCenterState,
        previous: NotificationCenterState
      ) => void
    ) => () => void
  }
  enabled?: () => boolean
  background?: () => boolean
  permission?: () => Promise<boolean>
  send?: (notification: AppNotification) => void | Promise<void>
} = {}) {
  let active = true
  const seen = new Map<string, number>()
  const deliver = (notification: AppNotification) => {
    if (seen.get(notification.id) === notification.toastRevision) return
    seen.set(notification.id, notification.toastRevision)
    if (
      !notification.toastVisible ||
      !enabled() ||
      !background() ||
      !["warning", "error"].includes(notification.severity)
    )
      return
    void (async () => {
      try {
        if (!(await permission()) || !active || !enabled() || !background())
          return
        const current = store
          .getState()
          .notifications.find((n) => n.id === notification.id)
        if (
          !current ||
          current.toastRevision !== notification.toastRevision ||
          !current.toastVisible
        )
          return
        await send(current)
      } catch {
        // The in-app history remains available if system delivery is unavailable.
      }
    })()
  }
  for (const notification of store.getState().notifications)
    deliver(notification)
  const unsubscribe = store.subscribe((state) => {
    for (const notification of state.notifications) deliver(notification)
    const retained = new Set(state.notifications.map((n) => n.id))
    for (const id of seen.keys()) if (!retained.has(id)) seen.delete(id)
  })
  return () => {
    active = false
    unsubscribe()
  }
}
