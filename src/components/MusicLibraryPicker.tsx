import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { createPortal } from "react-dom"
import { useLocation } from "wouter"
import {
  IconCheck,
  IconChevronDown,
  IconLoader2,
  IconMusic,
  IconRefresh,
  IconServer,
} from "@tabler/icons-react"
import { useShallow } from "zustand/react/shallow"
import { useConnectionStore } from "../backends/plex/connectionStore"
import { useCatalogueStore } from "../offline/catalogueStore"
import { useProviderStore } from "../stores/providerStore"
import { useNotificationCenterStore } from "../stores/notificationCenterStore"
import {
  createLibraryPickerApi,
  type LibraryServer,
  type MusicLibrary,
} from "../backends/plex/libraryPicker/api"
import "../styles/libraryPicker.css"

type ServerRow = LibraryServer & { sections?: MusicLibrary[]; error?: string }
export function MusicLibraryPicker() {
  const context = useCatalogueStore((s) => s.context)
  const provider = useProviderStore((s) => s.provider)
  const {
    title,
    sectionId,
    sectionUuid,
    sections,
    isLoading,
    isOffline,
    connect,
    switchLibrary,
  } = useConnectionStore(
    useShallow((s) => ({
      title: s.musicSectionTitle,
      sectionId: s.musicSectionId,
      sectionUuid: s.sectionUuid,
      sections: s.availableMusicSections,
      isLoading: s.isLoading,
      isOffline: s.isOffline,
      connect: s.connect,
      switchLibrary: s.switchLibrary,
    }))
  )
  const [location, navigate] = useLocation()
  const [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [rows, setRows] = useState<ServerRow[]>([]),
    [notice, setNotice] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null),
    generation = useRef(0),
    mounted = useRef(true),
    focusPending = useRef(false),
    id = useId()
  const [position, setPosition] = useState({ top: 64, left: 0, width: 340 })
  const scope = context?.cacheScope,
    revision = context?.connectionRevision,
    session = provider?.playbackSession
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [])
  useEffect(() => {
    generation.current++
    setRows([])
    setNotice(null)
    setOpen(false)
    setLoading(false)
  }, [scope, revision, session])
  useEffect(() => {
    setOpen(false)
  }, [location])
  const close = (focus = true) => {
    setOpen(false)
    if (focus) trigger.current?.focus()
  }
  function capture() {
    if (!context || !provider) return null
    const owned = { ...context },
      owner = provider,
      token = ++generation.current
    const current = () =>
      mounted.current &&
      generation.current === token &&
      useProviderStore.getState().provider === owner &&
      owner.playbackSession === session &&
      useCatalogueStore.getState().context?.connectionRevision ===
        owned.connectionRevision &&
      useCatalogueStore.getState().context?.cacheScope === owned.cacheScope
    return { current, api: createLibraryPickerApi(owned, current) }
  }
  async function discover() {
    const owned = capture()
    if (!owned) return
    setLoading(true)
    setNotice(null)
    try {
      const result = await owned.api.servers()
      if (!owned.current()) return
      setRows(result.servers)
      setNotice(result.notice)
      setLoading(false)
      await Promise.allSettled(
        result.servers.map(async (server) => {
          try {
            const libraries = await owned.api.sections(server.id)
            if (owned.current())
              setRows((rows) =>
                rows.map((row) =>
                  row.id === server.id ? { ...row, sections: libraries } : row
                )
              )
          } catch {
            if (owned.current())
              setRows((rows) =>
                rows.map((row) =>
                  row.id === server.id
                    ? { ...row, error: "Server unavailable" }
                    : row
                )
              )
          }
        })
      )
    } catch {
      if (owned.current()) {
        setLoading(false)
        setNotice(
          "Could not load your other servers. Your current library is still available."
        )
      }
    }
  }
  function toggle() {
    if (open) {
      close()
      return
    }
    focusPending.current = true
    setOpen(true)
    if (!rows.length) void discover()
  }
  async function choose(server: ServerRow, library: MusicLibrary) {
    if (
      server.current &&
      library.key === sectionId &&
      library.uuid === sectionUuid &&
      !isOffline
    ) {
      close()
      return
    }
    const owned = capture()
    if (!owned) return
    setSelected(`${server.id}:${library.key}`)
    try {
      if (server.id === "current") {
        const section = sections.find(
          (s) => s.key === library.key && s.uuid === library.uuid
        )
        if (!section) throw Error("Library choice expired")
        await switchLibrary(section)
      } else {
        const result = await owned.api.resolve(server.id, library)
        if (!owned.current()) return
        // Connect owns native revision, cache retirement, playback stop and
        // credential persistence; the menu never implements a second switch path.
        await connect(
          result.baseUrl,
          result.token,
          result.allUrls,
          result.sectionId,
          undefined,
          result.machineIdentifier,
          result.sectionUuid ?? undefined
        )
      }
      if (mounted.current) {
        setOpen(false)
        navigate("/")
      }
    } catch {
      if (mounted.current)
        useNotificationCenterStore.getState().notify({
          id: "library.switch",
          title: "Could not switch music libraries",
          message:
            "Check the server connection and try again from the library picker.",
          severity: "warning",
        })
    } finally {
      if (mounted.current) setSelected(null)
    }
  }
  useLayoutEffect(() => {
    if (
      !open ||
      (!focusPending.current && document.activeElement !== document.body)
    )
      return
    const first =
      panel.current?.querySelector<HTMLButtonElement>(
        'button[role="menuitemradio"][aria-checked="true"]:not(:disabled)'
      ) ??
      panel.current?.querySelector<HTMLButtonElement>(
        'button:not(:disabled)'
      )
    if (first) {
      first.focus()
      focusPending.current = false
    } else focusPending.current = true
  }, [open, rows, sections])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(340, window.innerWidth - 24)
      setPosition({
        top: rect.bottom + 10,
        left: Math.max(
          12,
          Math.min(rect.right - width, window.innerWidth - width - 12)
        ),
        width,
      })
    }
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close(false)
    }
    const key = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")
        close(false)
      if (event.key === "Escape") {
        event.preventDefault()
        close()
      }
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", key)
    }
  }, [open])
  function navigateOptions(event: KeyboardEvent) {
    if (event.key === "Tab") {
      close()
      return
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const options = [
      ...(panel.current?.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled)'
      ) ?? []),
    ]
    if (!options.length) return
    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % options.length
            : (current - 1 + options.length) % options.length
    options[index]?.focus()
  }
  const fallback: ServerRow = {
    id: "current",
    name: "Current server",
    current: true,
    sections: sections.map((s) => ({
      key: s.key,
      uuid: s.uuid ?? null,
      title: s.title,
    })),
  }
  const displayed = rows.length ? rows : sections.length ? [fallback] : []
  const serverName = rows.find((s) => s.current)?.name ?? "Plex"
  if (!context && !selected) return null
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="topbar-control shell-control-secondary library-picker-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Music library: ${title ?? "Plex"}. Switch library`}
        title={`${title ?? "Music library"} · ${serverName}`}
        disabled={isLoading || !!selected}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (!open) {
              event.preventDefault()
              toggle()
            } else navigateOptions(event)
          }
        }}
      >
        {isLoading || selected ? (
          <IconLoader2 size={17} className="animate-spin" aria-hidden="true" />
        ) : (
          <IconMusic size={17} aria-hidden="true" />
        )}
        <span className="library-picker-label">
          <span>
            {isLoading ? "Switching library…" : (title ?? "Music library")}
          </span>
          <span>{isOffline ? "Saved library" : serverName}</span>
        </span>
        <IconChevronDown
          size={14}
          aria-hidden="true"
          className={`library-picker-chevron ${open ? "is-open" : ""}`}
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="menu"
            aria-label="Music libraries"
            className="app-overlay-surface library-picker-panel"
            style={{
              ...position,
              maxHeight: `calc(100dvh - ${position.top + 12}px)`,
            }}
            onKeyDown={navigateOptions}
          >
            <div className="library-picker-heading">
              <span>Music libraries</span>
              <button
                type="button"
                role="menuitem"
                aria-label="Refresh music libraries"
                onClick={() => void discover()}
                disabled={loading || !!selected}
              >
                <IconRefresh
                  size={16}
                  className={loading ? "animate-spin" : ""}
                  aria-hidden="true"
                />
              </button>
            </div>
            <div className="library-picker-list">
              {displayed.map((server) => (
                <div
                  role="group"
                  aria-label={server.name}
                  key={server.id}
                  className="library-picker-group"
                >
                  <div className="library-picker-server">
                    <IconServer size={14} aria-hidden="true" />
                    <span>{server.name}</span>
                  </div>
                  {server.sections?.map((library) => {
                    const checked =
                      server.current &&
                      library.key === sectionId &&
                      library.uuid === sectionUuid
                    return (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={checked}
                        disabled={!!selected}
                        key={`${library.key}:${library.uuid}`}
                        className="library-picker-option"
                        onClick={() => void choose(server, library)}
                      >
                        <IconMusic size={16} aria-hidden="true" />
                        <span>{library.title}</span>
                        {selected === `${server.id}:${library.key}` ? (
                          <IconLoader2
                            size={16}
                            className="animate-spin"
                            aria-hidden="true"
                          />
                        ) : checked ? (
                          <IconCheck
                            size={16}
                            className="library-picker-check"
                            aria-hidden="true"
                          />
                        ) : null}
                      </button>
                    )
                  })}
                  {server.error ? (
                    <div className="library-picker-status">
                      {server.error}
                      <button type="button" role="menuitem" onClick={() => void discover()}>
                        Retry
                      </button>
                    </div>
                  ) : !server.sections ? (
                    <p className="library-picker-status" role="status">
                      Loading libraries…
                    </p>
                  ) : !server.sections.length ? (
                    <p className="library-picker-status">
                      No music libraries on this server.
                    </p>
                  ) : null}
                </div>
              ))}
              {loading && (
                <p className="library-picker-status" role="status">
                  Finding your servers…
                </p>
              )}
            </div>
            {notice && (
              <div className="library-picker-note">
                <p>{notice}</p>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close(false)
                    navigate("/settings/plex")
                  }}
                >
                  Connection settings
                </button>
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  )
}
