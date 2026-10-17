import { useModalLifecycle } from "../../hooks/useModalLifecycle"
import { createPortal } from "react-dom"
import { useProviderStore } from "../../stores/providerStore"
import { useId, useLayoutEffect, useRef, useState } from "react"
import { useLibraryStore } from "../../stores"
import type { MusicPlaylist } from "../../types/music"
import { IconCheck, IconX } from "@tabler/icons-react"

export function CreatePlaylist({
  onClose,
  onCreated,
  itemIds = [],
}: {
  onClose: () => void
  onCreated?: (playlist: MusicPlaylist) => void | Promise<void>
  itemIds?: string[]
}) {
  const provider = useProviderStore((s) => s.provider)
  const openedProvider = useRef(provider)
  const titleId = useId()
  const inputId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  useModalLifecycle(dialogRef, { onClose, initialFocus: inputRef, ownTabOrder: true })

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
      const playlist = await createPlaylist(playlistName.trim(), [...itemIds])
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
      className="fixed inset-0 z-20000 m-0 h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-black/60 p-0 text-white backdrop-blur-sm backdrop:bg-transparent open:flex"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
      }}
    >
      <div
        className="app-overlay-surface w-[calc(100%-2rem)] max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl bg-app-surface p-6"
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
            className="player-panel-icon"
          >
            <IconX size={20} aria-hidden="true" />
          </button>
        </div>

        {created ? (
          <div className="py-4 text-center">
            <IconCheck size={36} aria-hidden="true" className="mx-auto mb-3 text-(--text-primary)" />
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
              className="app-input w-full"
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
                className="media-secondary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!playlistName.trim() || isCreating}
                className="media-primary"
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
