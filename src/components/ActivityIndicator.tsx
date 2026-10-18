import { Button } from "./shared/Button"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "wouter"
import { useShallow } from "zustand/react/shallow"
import {
  IconDisc,
  IconLoader2,
  IconAlertCircle,
  IconCheck,
  IconPlayerPause,
  IconClock,
} from "@tabler/icons-react"
import { useLibraryStore } from "../stores"
import { useNotificationCenterStore } from "../stores/notificationCenterStore"
import { useBackgroundActivities } from "../activity/useBackgroundActivities"
import type { Activity } from "../activity/model"
export function ActivityIndicator() {
  const {
    prefetchStatus,
    isLoading,
    isFetchingMore,
    libraryScanning,
    libraryScanProgress,
  } = useLibraryStore(
    useShallow((s) => ({
      prefetchStatus: s.prefetchStatus,
      isLoading: s.isLoading,
      isFetchingMore: s.isFetchingMore,
      libraryScanning: s.libraryScanning,
      libraryScanProgress: s.libraryScanProgress,
    }))
  )
  const [isOpen, setIsOpen] = useState(false)
  const background = useBackgroundActivities(isOpen)
  const [, navigate] = useLocation()
  const panelRef = useRef<HTMLDivElement>(null),
    buttonRef = useRef<HTMLButtonElement>(null),
    panelId = useId()
  const [position, setPosition] = useState({ left: 0, top: 0, width: 320 })
  // Retire notifications from the former full-library mirror.
  useEffect(() => {
    const notices = useNotificationCenterStore.getState()
    for (const id of [
      "library.indexing",
      "library.indexing.retry",
      "library.playlists",
    ])
      notices.resolve(id)
  }, [])
  const activities: Activity[] = [...background]
  if (libraryScanning)
    activities.push({
      id: "library-scan",
      busy: true,
      label:
        libraryScanProgress != null
          ? `Library scanning · ${Math.round(libraryScanProgress)}%`
          : "Library scanning…",
    })
  if (prefetchStatus)
    activities.push({
      id: "prefetch",
      busy: true,
      label: `Caching playlists · ${prefetchStatus.done} of ${prefetchStatus.total}`,
    })
  if (isLoading)
    activities.push({
      id: "playlist-load",
      busy: true,
      label: "Loading playlist…",
    })
  if (isFetchingMore)
    activities.push({
      id: "load-more",
      busy: true,
      label: "Loading more tracks…",
    })
  const active = activities.filter((activity) => activity.busy).length
  const waiting = activities.length - active
  useLayoutEffect(() => {
    if (!isOpen) return
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(320, window.innerWidth - 24)
      setPosition({
        left: Math.max(
          12,
          Math.min(rect.right - width, window.innerWidth - width - 12)
        ),
        top: rect.bottom + 8,
        width,
      })
    }
    place()
    window.addEventListener("resize", place)
    return () => window.removeEventListener("resize", place)
  }, [isOpen])
  useEffect(() => {
    if (!isOpen) return
    function outside(event: PointerEvent) {
      if (
        !panelRef.current?.contains(event.target as Node) &&
        !buttonRef.current?.contains(event.target as Node)
      )
        setIsOpen(false)
    }
    function key(event: KeyboardEvent) {
      if (!event.defaultPrevented && event.key === "Escape") {
        event.preventDefault()
        setIsOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", key)
    }
  }, [isOpen])
  return (
    <>
      <Button
        variant="bare"
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label="Activity"
        title={
          active
            ? `${active} active operation${active === 1 ? "" : "s"}`
            : waiting ? `${waiting} operation${waiting === 1 ? "" : "s"} waiting` : "No active operations"
        }
        className={`topbar-control topbar-icon-control relative flex items-center justify-center rounded-full text-(--text-secondary) transition-colors hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${isOpen ? "bg-app-surface-hover" : "bg-app-surface"}`}
      >
        <IconDisc
          aria-hidden="true"
          size={18}
          className={active ? "animate-spin motion-reduce:animate-none text-accent" : ""}
          style={active ? { animationDuration: "2s" } : undefined}
        />
        {activities.some(activity => activity.state === "error" || activity.state === "paused") && (
          <span aria-hidden="true" className="absolute bottom-0 right-0 h-2 w-2 rounded-full bg-amber-400" />
        )}
      </Button>
      {isOpen &&
        createPortal(
          <div
            id={panelId}
            ref={panelRef}
            role="dialog"
            aria-label="Activity"
            style={position}
            className="app-overlay-surface fixed z-9999 max-h-[calc(100vh-140px)] overflow-y-auto rounded-xl border border-(--border) bg-app-surface shadow-2xl"
          >
            <div className="border-b border-(--border) px-4 py-3 text-xs font-semibold uppercase tracking-wider text-(--text-secondary)">
              Activity
            </div>
            {!activities.length ? (
              <p className="px-4 py-4 text-sm text-(--text-secondary)">
                No active operations.
              </p>
            ) : (
              <ul className="divide-y divide-(--border)">
                {activities.map((activity) => {
                  const Icon =
                    activity.state === "error"
                      ? IconAlertCircle
                      : activity.state === "paused"
                        ? IconPlayerPause
                        : activity.state === "waiting"
                          ? IconClock
                          : activity.busy
                            ? IconLoader2
                            : IconCheck
                  return (
                    <li
                      key={activity.id}
                      className="flex items-start gap-3 px-4 py-3"
                    >
                      <Icon
                        aria-hidden="true"
                        size={17}
                        className={`mt-0.5 shrink-0 ${activity.busy ? "animate-spin motion-reduce:animate-none text-accent" : "text-(--text-secondary)"}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-medium text-(--text-primary)">
                          {activity.label}
                        </p>
                        {activity.detail && (
                          <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-(--text-secondary)">
                            {activity.detail}
                          </p>
                        )}
                        {activity.progress && activity.progress.total > 0 && (
                          <div role="progressbar" aria-label={activity.progress.label}
                            aria-valuemin={0} aria-valuemax={activity.progress.total}
                            aria-valuenow={Math.min(activity.progress.total, Math.max(0, activity.progress.value))}
                            className="mt-2 h-1 overflow-hidden rounded-full bg-app-surface-hover">
                            <div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, activity.progress.value / activity.progress.total * 100))}%` }} />
                          </div>
                        )}
                        {activity.action && (
                          <Button
                            variant="secondary"
                            type="button"
                            onClick={() => { setIsOpen(false); navigate(activity.action!.href) }}
                            className="mt-2 rounded-md border border-(--border) px-2 py-1 text-xs text-(--text-primary) hover:bg-app-surface-hover"
                          >
                            {activity.action.label}
                          </Button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>,
          document.body
        )}
    </>
  )
}
