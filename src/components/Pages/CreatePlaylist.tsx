import { createPortal } from "react-dom"
import { useProviderStore } from "../../stores/providerStore"
import { useId, useLayoutEffect, useRef, useState } from "react"
import { useLibraryStore } from "../../stores"
import type { MusicPlaylist } from "../../types/music"

export function CreatePlaylist({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated?: (playlist: MusicPlaylist) => void | Promise<void>
}) {
  const provider = useProviderStore((s) => s.provider)
  const openedProvider = useRef(provider)
  const titleId = useId()
  const inputId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nativeModal = useRef(false)
  const sessionRef = useRef({ active: false, pending: false, completed: false })
  const [playlistName, setPlaylistName] = useState("")
  const [created, setCreated] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createPlaylist = useLibraryStore((s) => s.createPlaylist)

  useLayoutEffect(() => {
    const session = { active: true, pending: false, completed: false }
    sessionRef.current = session
    setCreated(false)
    setIsCreating(false)
    setError(null)
    return () => {
      session.active = false
      if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    }
  }, [provider])

  useLayoutEffect(() => {
    if (provider !== openedProvider.current) onClose()
  }, [provider])

  useLayoutEffect(() => {
    const dialog = dialogRef.current!
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    nativeModal.current = typeof dialog.showModal === "function"
    const hidden: {
      element: Element
      aria: string | null
      inert: string | null
    }[] = []
    const containFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node))
        (inputRef.current ?? closeRef.current)?.focus()
    }
    if (nativeModal.current) dialog.showModal()
    else {
      dialog.setAttribute("open", "")
      for (const element of [...document.body.children]) {
        if (element === dialog) continue
        hidden.push({
          element,
          aria: element.getAttribute("aria-hidden"),
          inert: element.getAttribute("inert"),
        })
        element.setAttribute("aria-hidden", "true")
        element.setAttribute("inert", "")
      }
      document.addEventListener("focusin", containFocus, true)
    }
    inputRef.current?.focus()
    return () => {
      if (nativeModal.current && dialog.open) dialog.close()
      else dialog.removeAttribute("open")
      document.removeEventListener("focusin", containFocus, true)
      for (const { element, aria, inert } of hidden) {
        if (aria === null) element.removeAttribute("aria-hidden")
        else element.setAttribute("aria-hidden", aria)
        if (inert === null) element.removeAttribute("inert")
        else element.setAttribute("inert", inert)
      }
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true })
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const session = sessionRef.current
    if (
      !playlistName.trim() ||
      !session.active ||
      session.pending ||
      session.completed
    )
      return
    session.pending = true
    const current = () =>
      session.active && useProviderStore.getState().provider === provider
    setIsCreating(true)
    setError(null)
    try {
      const playlist = await createPlaylist(playlistName.trim())
      if (!current()) return
      session.completed = true
      setCreated(true)
      closeRef.current?.focus()
      await onCreated?.(playlist)
      if (!current()) return
      closeTimer.current = setTimeout(() => {
        if (current()) onClose()
      }, 1200)
    } catch (err) {
      if (current())
        setError(
          session.completed
            ? `Playlist created, but the follow-up action failed: ${String(err)}`
            : String(err)
        )
    } finally {
      if (current()) {
        session.pending = false
        setIsCreating(false)
      }
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[20000] m-0 h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-black/60 p-0 text-white backdrop-blur-sm backdrop:bg-transparent open:flex"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === "Escape" && !nativeModal.current) {
          event.preventDefault()
          onClose()
        }
        if (event.key === "Tab") {
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled)"
            ),
          ]
          // macOS native keyboard settings may skip buttons entirely. Own the
          // complete tab order so every control stays reachable in either host.
          event.preventDefault()
          const index = controls.indexOf(document.activeElement as HTMLElement)
          const next =
            index < 0
              ? event.shiftKey
                ? controls.length - 1
                : 0
              : (index + (event.shiftKey ? -1 : 1) + controls.length) %
                controls.length
          controls[next]?.focus()
        }
      }}
    >
      <div
        className="app-overlay-surface w-[400px] rounded-xl bg-app-surface p-7 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 id={titleId} className="text-xl font-bold">
            Create playlist
          </h2>
          <button
            ref={closeRef}
            aria-label="Close create playlist"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:bg-white/10 hover:text-white"
          >
            ✕
          </button>
        </div>

        {created ? (
          <div className="py-4 text-center">
            <div className="mb-2 text-4xl">✓</div>
            <p role="status" className="font-semibold text-accent">
              Playlist created!
            </p>
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-400">
                {error}
              </p>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <label htmlFor={inputId} className="block text-sm font-semibold">
              Playlist name
            </label>
            <input
              ref={inputRef}
              id={inputId}
              disabled={isCreating}
              type="text"
              value={playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
              placeholder="My playlist #1"
              className="w-full rounded-md bg-app-surface px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-white/30"
            />
            {error && (
              <p role="alert" className="text-sm text-red-400">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="rounded-full px-5 py-2 text-sm font-semibold text-white hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!playlistName.trim() || isCreating}
                className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-black transition-opacity hover:scale-105 active:scale-95 disabled:opacity-40"
              >
                {isCreating ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>,
    document.body
  )
}
