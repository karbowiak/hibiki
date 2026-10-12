import { create } from "zustand"

export type NotificationSeverity = "info" | "success" | "warning" | "error"
export interface NotificationAction {
  label: string
  run: () => void | Promise<void>
}
export interface NotificationInput {
  id: string
  title: string
  message: string
  severity: NotificationSeverity
  persistent?: boolean
  action?: NotificationAction
}
export interface NotificationEntry extends NotificationInput {
  persistent: boolean
  createdAt: number
  updatedAt: number
  unread: boolean
  active: boolean
  occurrences: number
  toastVisible: boolean
  /** Changes only when a new toast should be shown, not during status polling. */
  toastRevision: number
  actionPending: boolean
}
export type AppNotification = NotificationEntry

export interface NotificationCenterState {
  notifications: NotificationEntry[]
  notify: (notification: NotificationInput) => void
  runAction: (id: string) => Promise<void>
  resolve: (id: string) => void
  /** Revision guards keep an old timer from dismissing a recurring notification. */
  dismissToast: (id: string, revision?: number) => void
  markAllRead: () => void
  clearHistory: () => void
}
const priority: Record<NotificationSeverity, number> = {
  info: 0,
  success: 0,
  warning: 1,
  error: 2,
}

/** Session-only history. Account credentials and callback actions never go to disk. */
export function createNotificationCenterStore({
  now = Date.now,
  historyLimit = 50,
}: { now?: () => number; historyLimit?: number } = {}) {
  const limit = Number.isFinite(historyLimit)
    ? Math.max(1, Math.floor(historyLimit))
    : 50
  function retain(entries: NotificationEntry[]) {
    let remaining = Math.max(
      0,
      limit - entries.filter((entry) => entry.active).length
    )
    // Persistent unresolved issues are retained even when they exceed the history limit.
    const kept = entries.filter((entry) => entry.active || remaining-- > 0)
    for (const entry of entries)
      if (!kept.includes(entry)) actionRuns.delete(entry.id)
    return kept
  }
  let toastSequence = 0
  const actionRuns = new Map<
    string,
    { token: symbol; promise: Promise<void> }
  >()
  return create<NotificationCenterState>((set, get) => ({
    notifications: [],
    notify: (input) =>
      set((state) => {
        const previous = state.notifications.find(
          (entry) => entry.id === input.id
        )
        const persistent = input.persistent ?? previous?.persistent ?? false
        const ongoing = persistent && previous?.active
        const escalate =
          previous && priority[input.severity] > priority[previous.severity]
        const newToast = !ongoing || !!escalate
        const timestamp = now()
        const entry: NotificationEntry = {
          ...input,
          persistent,
          createdAt: previous?.createdAt ?? timestamp,
          updatedAt: timestamp,
          unread: newToast ? true : previous!.unread,
          active: persistent,
          occurrences: (previous?.occurrences ?? 0) + (ongoing ? 0 : 1),
          toastVisible: newToast ? true : previous!.toastVisible,
          toastRevision: newToast ? ++toastSequence : previous!.toastRevision,
          actionPending: actionRuns.has(input.id),
        }
        return {
          notifications: retain([
            entry,
            ...state.notifications.filter(
              (existing) => existing.id !== input.id
            ),
          ]),
        }
      }),
    runAction: (id) => {
      const pending = actionRuns.get(id)
      if (pending) return pending.promise
      const action = get().notifications.find(
        (entry) => entry.id === id
      )?.action
      if (!action) return Promise.resolve()
      const token = Symbol(id)
      const promise = Promise.resolve()
        .then(() => action.run())
        .finally(() => {
          if (actionRuns.get(id)?.token !== token) return
          actionRuns.delete(id)
          set((state) => ({
            notifications: state.notifications.map((entry) =>
              entry.id === id ? { ...entry, actionPending: false } : entry
            ),
          }))
        })
      actionRuns.set(id, { token, promise })
      set((state) => ({
        notifications: state.notifications.map((entry) =>
          entry.id === id ? { ...entry, actionPending: true } : entry
        ),
      }))
      return promise
    },
    resolve: (id) => {
      actionRuns.delete(id)
      set((state) => ({
        notifications: state.notifications.map((entry) =>
          entry.id === id &&
          (entry.active ||
            entry.action ||
            entry.actionPending ||
            entry.toastVisible)
            ? {
                ...entry,
                active: false,
                action: undefined,
                actionPending: false,
                toastVisible: false,
                updatedAt: now(),
              }
            : entry
        ),
      }))
    },
    dismissToast: (id, revision) =>
      set((state) => ({
        notifications: state.notifications.map((entry) =>
          entry.id === id &&
          (revision === undefined || entry.toastRevision === revision)
            ? { ...entry, toastVisible: false }
            : entry
        ),
      })),
    markAllRead: () =>
      set((state) => ({
        notifications: state.notifications.map((entry) =>
          entry.unread ? { ...entry, unread: false } : entry
        ),
      })),
    clearHistory: () => {
      for (const entry of get().notifications)
        if (!entry.active) actionRuns.delete(entry.id)
      set((state) => ({
        notifications: state.notifications.filter((entry) => entry.active),
      }))
    },
  }))
}

export const useNotificationCenterStore = createNotificationCenterStore()
