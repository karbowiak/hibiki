import { create } from "zustand"

const STORAGE_KEY = "plex-notifications-enabled"

interface NotificationState {
  notificationsEnabled: boolean
  setNotificationsEnabled: (v: boolean) => void
}

export const useNotificationStore = create<NotificationState>(() => ({
  notificationsEnabled: localStorage.getItem(STORAGE_KEY) !== "0",

  setNotificationsEnabled: (v: boolean) => {
    localStorage.setItem(STORAGE_KEY, v ? "1" : "0")
    useNotificationStore.setState({ notificationsEnabled: v })
  },
}))
