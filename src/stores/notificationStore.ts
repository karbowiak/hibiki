import { create } from "zustand"
import { booleanPreference } from "./scalarPreference"

const STORAGE_KEY = "plex-notifications-enabled"

const preference = booleanPreference(STORAGE_KEY, true)

interface NotificationState {
  notificationsEnabled: boolean
  setNotificationsEnabled: (v: boolean) => void
}

export const useNotificationStore = create<NotificationState>(() => ({
  notificationsEnabled: preference.snapshot(),

  setNotificationsEnabled: (v: boolean) => {
    preference.set(v)
    useNotificationStore.setState({ notificationsEnabled: v })
  },
}))

preference.subscribe(() => useNotificationStore.setState({ notificationsEnabled: preference.snapshot() }))
