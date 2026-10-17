import { createPortal } from "react-dom"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { useLocation } from "wouter"
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconBell,
  IconCircleCheck,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react"
import {
  useNotificationCenterStore,
  type AppNotification,
} from "../stores/notificationCenterStore"

function NotificationIcon({
  severity,
}: {
  severity: AppNotification["severity"]
}) {
  const props = { size: 19, stroke: 1.7, "aria-hidden": true as const }
  if (severity === "error")
    return <IconAlertCircle {...props} className="text-red-400" />
  if (severity === "warning")
    return <IconAlertTriangle {...props} className="text-amber-500" />
  if (severity === "success")
    return <IconCircleCheck {...props} className="text-emerald-500" />
  return <IconInfoCircle {...props} className="text-accent" />
}

function NotificationAction({
  notification,
}: {
  notification: AppNotification
}) {
  if (!notification.action) return null
  return (
    <button
      type="button"
      disabled={notification.actionPending}
      className="mt-3 rounded-md bg-app-surface px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-app-surface-hover disabled:opacity-50"
      onClick={() => {
        void useNotificationCenterStore
          .getState()
          .runAction(notification.id)
          .catch(() => {
            const current = useNotificationCenterStore
              .getState()
              .notifications.find((n) => n.id === notification.id)
            if (
              !current?.action ||
              current.toastRevision !== notification.toastRevision
            )
              return
            useNotificationCenterStore.getState().notify({
              id: `notification-action:${notification.id}`,
              title: "Action could not be completed",
              message:
                "Please try again. The original notification is still available.",
              severity: "warning",
            })
          })
      }}
    >
      {notification.actionPending ? "Working…" : notification.action.label}
    </button>
  )
}

function NotificationContent({
  notification,
}: {
  notification: AppNotification
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div className="mt-0.5 shrink-0">
        <NotificationIcon severity={notification.severity} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="wrap-break-word text-sm font-semibold text-white">
          {notification.title}
        </p>
        <p className="mt-1 wrap-break-word text-sm leading-relaxed text-white/60">
          {notification.message}
        </p>
        <NotificationAction notification={notification} />
      </div>
    </div>
  )
}

export function NotificationCenter() {
  const notifications = useNotificationCenterStore((s) => s.notifications)
  const [open, setOpen] = useState(false)
  const [location] = useLocation()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const panelId = useId()
  const [position, setPosition] = useState<{
    left: number
    top: number
    width: number
    maxHeight: number
  } | null>(null)
  const unread = notifications.filter((n) => n.unread).length
  const history = [...notifications].sort(
    (a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt
  )

  const close = () => {
    setOpen(false)
    buttonRef.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    setOpen(false)
  }, [location])
  useEffect(() => {
    if (!open) return
    const notices = useNotificationCenterStore.getState()
    if (unread) notices.markAllRead()
    for (const notification of notifications)
      if (notification.toastVisible)
        notices.dismissToast(notification.id, notification.toastRevision)
  }, [open, unread, notifications])
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const button = buttonRef.current?.getBoundingClientRect()
      if (!button) return
      const width = Math.min(384, window.innerWidth - 24)
      const top = Math.max(
        8,
        Math.min(button.bottom + 12, window.innerHeight - 100)
      )
      const next = {
        width,
        top,
        left: Math.max(
          12,
          Math.min(button.right - width, window.innerWidth - width - 12)
        ),
        maxHeight: Math.min(560, window.innerHeight - top - 12),
      }
      setPosition((previous) =>
        previous &&
        Object.keys(next).every(
          (key) =>
            next[key as keyof typeof next] ===
            previous[key as keyof typeof next]
        )
          ? previous
          : next
      )
    }
    update()
    const observer = new ResizeObserver(update)
    if (buttonRef.current) observer.observe(buttonRef.current)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [open])
  useEffect(() => {
    if (!open || !position) return
    panelRef.current?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (
        !panelRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      )
        setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", escape)
    }
  }, [open, !!position])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={
          unread ? `Notifications, ${unread} unread` : "Notifications"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="Notifications"
        onClick={() => setOpen((value) => !value)}
        className={`topbar-control topbar-icon-control shell-control-secondary relative flex items-center justify-center rounded-full transition-colors ${open ? "bg-accent/15 text-accent" : "bg-app-surface text-(--text-secondary) hover:bg-app-surface-hover"}`}
      >
        <IconBell size={17} stroke={1.7} aria-hidden="true" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold leading-4 text-black"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-labelledby={titleId}
            tabIndex={-1}
            style={position}
            className="app-overlay-surface fixed z-12000 flex flex-col overflow-hidden rounded-xl border border-(--border) bg-app-card text-white shadow-2xl outline-none"
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Escape") {
                event.preventDefault()
                close()
              }
            }}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-(--border-subtle) px-4 py-3">
              <h2 id={titleId} className="flex-1 text-sm font-semibold">
                Notifications
              </h2>
              {notifications.some((n) => !n.active) && (
                <button
                  type="button"
                  onClick={() =>
                    useNotificationCenterStore.getState().clearHistory()
                  }
                  className="rounded px-2 py-1 text-xs text-white/60 hover:bg-app-surface hover:text-white"
                >
                  Clear history
                </button>
              )}
              <button
                type="button"
                onClick={close}
                aria-label="Close notifications"
                className="flex h-7 w-7 items-center justify-center rounded-full text-white/60 hover:bg-app-surface hover:text-white"
              >
                <IconX size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 overflow-y-auto overscroll-contain">
              {history.length ? (
                <ul className="divide-y divide-(--border-subtle)">
                  {history.map((notification) => (
                    <li key={notification.id} className="px-4 py-4">
                      <NotificationContent notification={notification} />
                      <div className="ml-8 mt-2 flex items-center gap-2 text-xs text-(--text-secondary)">
                        <time
                          dateTime={new Date(
                            notification.updatedAt
                          ).toISOString()}
                        >
                          {new Date(notification.updatedAt).toLocaleTimeString(
                            [],
                            { hour: "2-digit", minute: "2-digit" }
                          )}
                        </time>
                        {notification.active && <span>Needs attention</span>}
                        {notification.occurrences > 1 && (
                          <span>Occurred {notification.occurrences} times</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-col items-center px-6 py-10 text-center">
                  <IconBell
                    size={30}
                    stroke={1.2}
                    className="mb-3 text-white/30"
                    aria-hidden="true"
                  />
                  <p className="text-sm font-medium">You’re all caught up</p>
                  <p className="mt-1 text-xs leading-relaxed text-white/50">
                    Updates and anything that needs your attention will appear
                    here.
                  </p>
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

function NotificationToast({
  notification,
}: {
  notification: AppNotification
}) {
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused || notification.actionPending) return
    const timer = setTimeout(
      () =>
        useNotificationCenterStore
          .getState()
          .dismissToast(notification.id, notification.toastRevision),
      notification.severity === "error" ? 10000 : 7000
    )
    return () => clearTimeout(timer)
  }, [
    notification.id,
    notification.toastRevision,
    notification.severity,
    notification.actionPending,
    paused,
  ])
  return (
    <div
      role="status"
      className="app-overlay-surface pointer-events-auto relative rounded-xl border border-(--border) bg-app-card p-4 pr-10 text-white shadow-xl"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false)
      }}
    >
      <NotificationContent notification={notification} />
      <button
        type="button"
        aria-label={`Dismiss notification: ${notification.title}`}
        onClick={() =>
          useNotificationCenterStore.getState().dismissToast(notification.id)
        }
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-white/50 hover:bg-app-surface hover:text-white"
      >
        <IconX size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

export function NotificationToasts() {
  const notifications = useNotificationCenterStore((s) => s.notifications)
  const [position, setPosition] = useState({ top: 80, maxHeight: 500 })
  useLayoutEffect(() => {
    const toolbar = document.querySelector<HTMLElement>("[data-app-toolbar]")
    const player = document.querySelector<HTMLElement>("[data-player-bar]")
    const update = () => {
      const top = Math.max(
        16,
        (toolbar?.getBoundingClientRect().bottom ?? 68) + 12
      )
      const bottom = Math.min(
        window.innerHeight - 16,
        (player?.getBoundingClientRect().top ?? window.innerHeight) - 12
      )
      setPosition((previous) =>
        previous.top === top &&
        previous.maxHeight === Math.max(80, bottom - top)
          ? previous
          : { top, maxHeight: Math.max(80, bottom - top) }
      )
    }
    update()
    const observer = new ResizeObserver(update)
    if (toolbar) observer.observe(toolbar)
    if (player) observer.observe(player)
    window.addEventListener("resize", update)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", update)
    }
  }, [])
  const toasts = notifications
    .filter((n) => n.toastVisible)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)
  if (!toasts.length) return null
  return createPortal(
    <div
      aria-label="Recent notifications"
      style={position}
      className="pointer-events-none fixed right-4 z-11000 flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-3 overflow-y-auto overscroll-contain p-1"
    >
      {toasts.map((notification) => (
        <NotificationToast key={notification.id} notification={notification} />
      ))}
    </div>,
    document.body
  )
}
