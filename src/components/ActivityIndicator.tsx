import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
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
import { useCatalogueStore } from "../offline/catalogueStore"
import { catalogueRetry } from "../offline/catalogue"
import { useOfflineStatusStore } from "../offline/statusStore"
import { useNotificationCenterStore } from "../stores/notificationCenterStore"

interface Activity {
  id: string
  label: string
  detail?: string
  busy?: boolean
  state?: "paused" | "error" | "complete" | "waiting"
  retry?: () => void
}
function phaseLabel(task: string) {
  if (task.startsWith("catchup:")) return "Checking for changes"
  if (task.startsWith("playlist:")) return "Playlist contents"
  if (task.startsWith("details:")) return "Full music metadata"
  return (
    (
      {
        artist: "Artists",
        album: "Albums",
        track: "Tracks",
        playlist: "Playlists",
      } as Record<string, string>
    )[task] ?? "Audio analysis"
  )
}
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
  const progress = useCatalogueStore((state) => state.progress),
    context = useCatalogueStore((state) => state.context)
  const offline = useOfflineStatusStore((state) => state.offlineMode)
  const [isOpen, setIsOpen] = useState(false),
    [retrying, setRetrying] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null),
    buttonRef = useRef<HTMLButtonElement>(null),
    panelId = useId()
  const [position, setPosition] = useState({ left: 0, top: 0, width: 320 })
  const bulkTasks = progress?.tasks.filter(
    (task) =>
      !task.task.startsWith("catchup:") &&
      !task.task.startsWith("analysis:") &&
      !task.task.startsWith("playlist:")
  )
  const playlistFailures =
    progress?.tasks.filter(
      (task) => task.task.startsWith("playlist:") && task.status === "error"
    ).length ?? 0
  const task =
    bulkTasks?.find((task) => task.status === "error") ??
    bulkTasks?.find((task) => task.status !== "complete")
  const failed = task?.status === "error"
  const owns = () =>
    !!context &&
    context.connectionRevision ===
      useCatalogueStore.getState().context?.connectionRevision &&
    context.cacheScope === useCatalogueStore.getState().context?.cacheScope
  async function retry() {
    if (!context || retrying || offline) return
    setRetrying(true)
    try {
      await catalogueRetry(context)
    } catch {
      if (owns())
        useNotificationCenterStore.getState().notify({
          id: "library.indexing.retry",
          title: "Could not resume library indexing",
          message: "Check your Plex connection and try again.",
          severity: "warning",
        })
    } finally {
      setRetrying(false)
    }
  }
  useEffect(() => {
    const notices = useNotificationCenterStore.getState()
    if (!failed || !context) {
      notices.resolve("library.indexing")
      return
    }
    notices.notify({
      id: "library.indexing",
      title: "Library indexing paused",
      message:
        "Hibiki could not finish saving your library. Check your Plex connection and retry from Activity.",
      severity: "warning",
      persistent: true,
    })
  }, [failed, context?.cacheScope, context?.connectionRevision])
  useEffect(() => {
    const notices = useNotificationCenterStore.getState()
    if (!playlistFailures || !context) {
      notices.resolve("library.playlists")
      return
    }
    notices.notify({
      id: "library.playlists",
      title: "Some playlist contents are waiting to update",
      message:
        "Hibiki will retry automatically. Other library indexing continues, and any previously saved playlist version stays available.",
      severity: "warning",
      persistent: true,
    })
  }, [playlistFailures, context?.cacheScope, context?.connectionRevision])
  const activities: Activity[] = []
  if (progress && context && progress.tasks.length) {
    const paused = offline || task?.status === "paused",
      busy = !paused && !failed && !!task
    const phase = task
      ? `${task.scanMode === "verify" ? "Verifying playlist contents" : phaseLabel(task.task)}${task.total != null ? `: ${(task.scanMode === "verify" ? (task.keyCursor ?? 0) : task.cursor).toLocaleString()} / ${task.total.toLocaleString()}` : ""}`
      : ""
    activities.push({
      id: "catalogue",
      busy,
      state: failed
        ? "error"
        : paused
          ? "paused"
          : busy
            ? undefined
            : "complete",
      label: failed
        ? "Library indexing needs attention"
        : paused
          ? "Library indexing paused"
          : busy
            ? "Saving your library"
            : "Library saved on this device",
      detail: [
        phase,
        `${progress.entities.toLocaleString()} items saved`,
        progress.incremental?.watermark
          ? `Changes last checked ${new Date(progress.incremental.watermark * 1000).toLocaleTimeString()}`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
      retry: failed && !offline && !retrying ? () => void retry() : undefined,
    })
  }
  const playlistTask = progress?.tasks.find(
    (task) =>
      task.task.startsWith("playlist:") &&
      !["complete", "error"].includes(task.status)
  )
  if (progress && context && playlistTask) {
    const paused = offline || playlistTask.status === "paused"
    const verifying = playlistTask.scanMode === "verify"
    activities.push({
      id: "catalogue-playlist-progress",
      label: paused
        ? "Playlist saving paused"
        : verifying
          ? "Verifying playlist contents"
          : "Saving playlist contents",
      busy: !paused,
      state: paused ? "paused" : undefined,
      detail: `${verifying ? "Verifying playlist contents" : "Playlist contents"}${playlistTask.total != null ? `: ${(verifying ? (playlistTask.keyCursor ?? 0) : playlistTask.cursor).toLocaleString()} / ${playlistTask.total.toLocaleString()}` : ""}`,
    })
  }
  const waveformTask = progress?.tasks.find(
    (task) => task.task.startsWith("analysis:") && task.status !== "complete"
  )
  if (
    progress &&
    context &&
    (waveformTask ||
      progress.analysisPending ||
      progress.waveforms ||
      progress.analysisUnavailable)
  ) {
    const paused = offline || waveformTask?.status === "paused"
    const failed = waveformTask?.status === "error"
    const busy =
      !paused && !failed && (!!waveformTask || progress.analysisPending > 0)
    activities.push({
      id: "catalogue-waveforms",
      label: failed
        ? "Waveform collection needs attention"
        : paused
          ? "Waveform collection paused"
          : busy
            ? "Saving waveforms"
            : "Waveforms saved on this device",
      busy,
      state: failed
        ? "error"
        : paused
          ? "paused"
          : busy
            ? undefined
            : "complete",
      detail: [
        waveformTask?.task === "analysis:discover"
          ? "Checking saved audio streams"
          : null,
        `${progress.waveforms.toLocaleString()} saved · ${progress.analysisPending.toLocaleString()} remaining`,
        progress.analysisUnavailable
          ? `${progress.analysisUnavailable.toLocaleString()} unavailable from Plex`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
      retry: failed && !offline && !retrying ? () => void retry() : undefined,
    })
  }
  if (context && playlistFailures) {
    activities.push({
      id: "catalogue-playlists",
      busy: false,
      state: offline ? "paused" : "error",
      label: "Playlist contents waiting to update",
      detail: `${playlistFailures.toLocaleString()} ${playlistFailures === 1 ? "playlist" : "playlists"} will retry automatically.\nOther indexing continues; previously saved versions stay available.`,
      retry: !offline && !retrying ? () => void retry() : undefined,
    })
  }
  const incremental = progress?.incremental
  if (
    context &&
    incremental &&
    (incremental.pending > 0 ||
      incremental.catchUpRequested ||
      incremental.phase !== "idle")
  ) {
    const catchingUp = incremental.phase === "catchingUp"
    const busy = !offline && incremental.phase !== "idle"
    activities.push({
      id: "catalogue-updates",
      busy,
      state: offline ? "paused" : !busy ? "waiting" : undefined,
      label: offline
        ? "Library updates paused"
        : !busy
          ? "Library update scheduled"
          : catchingUp
            ? "Checking Plex for changes"
            : "Updating saved metadata",
      detail:
        !busy && !offline
          ? "Waiting for the next background check. Browsing and playback are ready."
          : incremental.pending
            ? `${incremental.pending.toLocaleString()} ${incremental.pending === 1 ? "item" : "items"} awaiting updates`
            : "Only new or changed items are fetched.",
    })
  }
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
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-haspopup="dialog"
        title={
          failed
            ? "Activity · library indexing needs attention"
            : active
              ? `${active} active operation${active === 1 ? "" : "s"}`
              : "No active operations"
        }
        className={`relative flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${isOpen ? "bg-app-surface-hover" : "bg-app-surface"}`}
      >
        <IconDisc
          aria-hidden="true"
          size={18}
          className={active ? "animate-spin text-accent" : ""}
          style={active ? { animationDuration: "2s" } : undefined}
        />
        {failed && (
          <span
            aria-hidden="true"
            className="absolute right-0 top-0 h-2 w-2 rounded-full bg-amber-400"
          />
        )}
      </button>
      {isOpen &&
        createPortal(
          <div
            id={panelId}
            ref={panelRef}
            role="dialog"
            aria-label="Activity"
            style={position}
            className="fixed z-[9999] max-h-[calc(100vh-140px)] overflow-y-auto rounded-xl border border-[var(--border)] bg-app-surface shadow-2xl"
          >
            <div className="border-b border-[var(--border)] px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
              Activity
            </div>
            {!activities.length ? (
              <p className="px-4 py-4 text-sm text-[var(--text-secondary)]">
                No active operations.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
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
                        className={`mt-0.5 shrink-0 ${activity.busy ? "animate-spin text-accent" : "text-[var(--text-secondary)]"}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-[var(--text-primary)]">
                          {activity.label}
                        </p>
                        {activity.detail && (
                          <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-[var(--text-secondary)]">
                            {activity.detail}
                          </p>
                        )}
                        {activity.retry && (
                          <button
                            type="button"
                            onClick={activity.retry}
                            className="mt-2 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-primary)] hover:bg-app-surface-hover"
                          >
                            Retry indexing
                          </button>
                        )}
                        {activity.id === "catalogue" && retrying && (
                          <p
                            role="status"
                            className="mt-2 text-xs text-[var(--text-secondary)]"
                          >
                            Resuming…
                          </p>
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
