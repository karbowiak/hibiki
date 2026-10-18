import { Button } from "./shared/Button"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  IconAlertTriangle,
  IconLoader2,
  IconX,
} from "@tabler/icons-react"
import {
  youtubeMusicApi,
  type YoutubeMusicApi,
  type YoutubeMusicStatus,
  type YoutubeMusicHelpers,
} from "../backends/ytmusic/api"
import { YoutubeMusicLogo } from "./shared/MusicSource"

const disconnected: YoutubeMusicStatus = {
  enabled: false,
  phase: "disconnected",
  lastCheckedAt: null,
  nextRefreshAt: null,
  message: null,
}
const phaseLabels: Record<YoutubeMusicStatus["phase"], string> = {
  disconnected: "Not connected",
  connecting: "Waiting for sign-in",
  connected: "Connected",
  refreshing: "Refreshing session",
  reauthRequired: "Sign in again",
  unavailable: "Connection unavailable",
}

export function YoutubeMusicConnection({
  api = youtubeMusicApi,
}: {
  api?: YoutubeMusicApi
}) {
  const [status, setStatus] = useState(disconnected)
  const [open, setOpen] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [helpers, setHelpers] = useState<YoutubeMusicHelpers | null>(null)
  const [installing, setInstalling] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const id = useId()
  const [position, setPosition] = useState({ left: 12, top: 64, width: 400 })

  useEffect(() => {
    mounted.current = true
    let disposed = false,
      unlisten: (() => void) | undefined,
      unlistenHelpers: (() => void) | undefined,
      events = 0
    const receive = (value: YoutubeMusicStatus) => {
      if (disposed || !value?.phase) return
      events++
      setStatus(value)
      if (!value.enabled) {
        setNotice(null)
      }
    }
    void (async () => {
      unlistenHelpers = await api.subscribeHelpers((value) => {
        if (!disposed) setHelpers(value)
      })
      if (disposed) {
        unlistenHelpers()
        return
      }
      unlisten = await api.subscribe(receive)
      if (disposed) {
        unlisten()
        return
      }
      const before = events
      const value = await api.status()
      if (events === before) receive(value)
    })().catch(() => {
      /* Optional service must not interrupt Plex startup. */
    })
    return () => {
      disposed = true
      mounted.current = false
      unlisten?.()
      unlistenHelpers?.()
    }
  }, [api])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(400, window.innerWidth - 24)
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
    panel.current?.focus()
    window.addEventListener("resize", place)
    return () => window.removeEventListener("resize", place)
  }, [open])
  useEffect(() => {
    if (!open) return
    void api
      .helpers()
      .then((value) => {
        if (mounted.current) setHelpers(value)
      })
      .catch(() => {})
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", key)
    }
  }, [api, open])

  async function act(action: "connect" | "refresh" | "disconnect") {
    if (working) return
    setWorking(true)
    setError(null)
    setNotice(null)
    try {
      await api[action]()
      const value = await api.status()
      if (mounted.current && value?.phase) setStatus(value)
    } catch (error) {
      if (mounted.current)
        setError(
          typeof error === "string"
            ? error
            : "Could not update the YouTube Music connection. Try again."
        )
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  async function installTools() {
    setInstalling(true)
    setError(null)
    setNotice(null)
    try {
      const value = await api.installHelpers()
      if (mounted.current) {
        setHelpers(value)
        setNotice("Playback tools installed.")
      }
    } catch (error) {
      if (mounted.current)
        setError(
          typeof error === "string"
            ? error
            : "Could not install playback tools. Please retry."
        )
    } finally {
      if (mounted.current) setInstalling(false)
    }
  }
  const toolsBusy = installing || helpers?.installing
  const busy =
    working || status.phase === "connecting" || status.phase === "refreshing"
  const attention = status.phase === "reauthRequired"
  const button =
    "min-h-9 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50"

  return (
    <>
      <Button
        variant="bare"
        ref={trigger}
        type="button"
        data-ytmusic-connection
        aria-label={`YouTube Music: ${phaseLabels[status.phase]}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={`YouTube Music · ${phaseLabels[status.phase]}`}
        onClick={() => {
          if (!status.enabled || attention) {
            setOpen(true)
            void act("connect")
          } else setOpen((value) => !value)
        }}
        className="topbar-control topbar-icon-control shell-control-secondary bg-app-surface hover:bg-app-surface-hover focus-visible:outline-accent relative flex items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2"
      >
        <YoutubeMusicLogo />
        {attention ? (
          <IconAlertTriangle
            size={13}
            aria-hidden="true"
            className="bg-app-surface absolute -right-0.5 -bottom-0.5 rounded-sm text-amber-700 dark:text-amber-400"
          />
        ) : busy ? (
          <IconLoader2
            size={11}
            aria-hidden="true"
            className="bg-app-surface absolute -right-0.5 -bottom-0.5 animate-spin rounded-full text-(--text-secondary) motion-reduce:animate-none"
          />
        ) : status.phase === "connected" ? (
          <span
            aria-hidden="true"
            className="ring-app-surface absolute right-0 bottom-0 h-2 w-2 rounded-full bg-green-600 ring-2"
          />
        ) : null}
      </Button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-labelledby={`${id}-title`}
            tabIndex={-1}
            style={position}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Escape") {
                event.preventDefault()
                setOpen(false)
                trigger.current?.focus()
              }
            }}
            className="app-overlay-surface fixed z-9999 max-h-[calc(100dvh-110px)] overflow-y-auto rounded-xl border border-(--border) p-4 text-(--text-primary) focus:outline-none"
          >
            <header className="flex items-start justify-between gap-3">
              <div>
                <h2 id={`${id}-title`} className="font-semibold">
                  YouTube Music
                </h2>
                <p
                  role="status"
                  className="mt-1 text-sm text-(--text-secondary)"
                >
                  {phaseLabels[status.phase]}
                </p>
              </div>
              <Button
                variant="bare"
                type="button"
                aria-label="Close YouTube Music"
                className="player-panel-icon"
                onClick={() => {
                  setOpen(false)
                  trigger.current?.focus()
                }}
              >
                <IconX size={18} aria-hidden="true" />
              </Button>
            </header>
            {status.message && (
              <p className="mt-3 text-sm text-(--text-secondary)">
                {status.message}
              </p>
            )}
            <p className="mt-3 text-sm leading-relaxed text-(--text-secondary)">
              {status.enabled
                ? "Your session refreshes automatically."
                : "Connect your YouTube Music account."}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                type="button"
                disabled={working}
                className={`${button} bg-accent text-black hover:brightness-110`}
                onClick={() => void act("connect")}
              >
                {status.enabled ? "Open sign-in window" : "Sign in"}
              </Button>
              {status.enabled && (
                <>
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={busy}
                    className={`${button} bg-accent-tint-strong text-(--text-primary) hover:bg-accent-tint-hover`}
                    onClick={() => void act("refresh")}
                  >
                    Refresh session
                  </Button>
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={working}
                    className={`${button} text-red-700 hover:bg-red-500/10 dark:text-red-400`}
                    onClick={() => void act("disconnect")}
                  >
                    Disconnect
                  </Button>
                </>
              )}
            </div>
            {status.lastCheckedAt && (
              <p className="mt-3 text-xs text-(--text-secondary)">
                Last checked{" "}
                {new Date(status.lastCheckedAt * 1000).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            )}
            {helpers && (
              <div className="mt-4 border-t border-(--border) pt-4">
                <p className="text-sm text-(--text-secondary)">
                  {toolsBusy
                    ? "Downloading playback tools…"
                    : helpers.managed
                      ? "Playback tools ready."
                      : helpers.ytDlp && helpers.javascriptRuntime
                        ? "Playback tools available on this computer."
                        : "Install playback tools to start listening."}
                </p>
                <Button
                  variant="secondary"
                  type="button"
                  className={`${button} mt-3 bg-accent-tint-strong text-(--text-primary) hover:bg-accent-tint-hover`}
                  disabled={toolsBusy}
                  onClick={() => void installTools()}
                >
                  {toolsBusy
                    ? `Downloading${helpers.progress != null ? `… ${helpers.progress}%` : "…"}`
                    : helpers.managed
                      ? "Reinstall playback tools"
                      : "Install playback tools"}
                </Button>
                <p className="mt-2 text-xs text-(--text-secondary)">
                  yt-dlp · Node
                </p>
              </div>
            )}
            {notice && (
              <p role="status" className="mt-3 text-sm text-(--text-secondary)">
                {notice}
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="mt-3 text-sm text-red-700 dark:text-red-400"
              >
                {error}
              </p>
            )}
            <p className="mt-4 border-t border-(--border) pt-4 text-xs leading-relaxed text-(--text-secondary)">
              Unofficial integration. Not supported or endorsed by Google or
              YouTube. Use may violate YouTube’s terms and could lead to account
              restrictions or suspension. Use at your own risk.
            </p>
          </div>,
          document.body
        )}
    </>
  )
}
