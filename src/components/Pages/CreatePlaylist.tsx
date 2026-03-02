import { useState } from "react"
import { useLibraryStore, useConnectionStore } from "../../stores"
import type { Playlist } from "../../types/plex"

export function CreatePlaylist({ onClose, onCreated }: { onClose: () => void; onCreated?: (playlist: Playlist) => void }) {
  const [playlistName, setPlaylistName] = useState("")
  const [created, setCreated] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { createPlaylist } = useLibraryStore()
  const { musicSectionId } = useConnectionStore()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!playlistName.trim() || musicSectionId === null) return
    setIsCreating(true)
    setError(null)
    try {
      const playlist = await createPlaylist(playlistName.trim(), musicSectionId)
      onCreated?.(playlist)
      setCreated(true)
      setTimeout(onClose, 1200)
    } catch (err) {
      setError(String(err))
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[400px] rounded-xl bg-app-surface p-7 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-bold">Create playlist</h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:bg-white/10 hover:text-white"
          >
            ✕
          </button>
        </div>

        {created ? (
          <div className="py-4 text-center">
            <div className="mb-2 text-4xl">✓</div>
            <p className="font-semibold text-accent">Playlist created!</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <input
              type="text"
              value={playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
              placeholder="My playlist #1"
              className="w-full rounded-md bg-[#3e3e3e] px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-white/30"
              autoFocus
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
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
                disabled={!playlistName.trim() || isCreating || musicSectionId === null}
                className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-black transition-opacity disabled:opacity-40 hover:scale-105 active:scale-95"
              >
                {isCreating ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
