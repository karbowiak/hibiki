import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { IconFolder, IconFolderOpen } from "@tabler/icons-react"

export interface DownloadStorageInfo {
  directory: string
  defaultDirectory: string
  moving: boolean
  totalBytes: number
  tracks: number
  error: string | null
}
export function DownloadStorageControls() {
  const [info, setInfo] = useState<DownloadStorageInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const current = useRef(true)
  const pending = useRef(false)
  useEffect(() => {
    current.current = true
    let reading = false
    let active = true
    const refresh = async () => {
      if (reading || pending.current) return
      reading = true
      try {
        const next = await invoke<DownloadStorageInfo>("download_storage_info")
        if (active) {
          setInfo(next)
          setError((previous) =>
            previous === "Could not read the download folder. Try again."
              ? ""
              : previous
          )
        }
      } catch {
        if (active) setError("Could not read the download folder. Try again.")
      } finally {
        reading = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      current.current = false
      clearInterval(timer)
    }
  }, [])
  async function change(
    command: "download_storage_choose" | "download_storage_retry"
  ) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError("")
    try {
      const next = await invoke<DownloadStorageInfo>(command)
      if (current.current) setInfo(next)
    } catch (reason) {
      if (current.current)
        setError(
          typeof reason === "string"
            ? reason
            : "Could not move downloads. Your existing files are still available."
        )
    } finally {
      pending.current = false
      if (current.current) setBusy(false)
    }
  }
  const moving = busy || !!info?.moving
  return (
    <div className="space-y-4" aria-busy={moving}>
      <div className="flex min-w-0 items-start gap-3">
        <IconFolder
          size={20}
          className="mt-0.5 shrink-0 text-(--text-secondary)"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="break-all text-sm font-medium text-(--text-primary)">
            {info?.directory ?? "Loading download folder…"}
          </p>
          {info && (
            <p className="mt-1 text-xs text-(--text-secondary)">
              {info.tracks.toLocaleString()}{" "}
              {info.tracks === 1 ? "song" : "songs"} ·{" "}
              {(info.totalBytes / 1024 ** 3).toFixed(2)} GiB
            </p>
          )}
        </div>
      </div>
      <p className="text-sm leading-relaxed text-(--text-secondary)">
        Songs are organized by artist and album. Downloaded playlists get an M3U
        file in the Playlists folder, updated as songs finish downloading. Each
        song is stored once.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={moving || !info}
          className="settings-choice rounded-lg border border-(--border) bg-app-surface px-3 py-1.5 text-sm text-(--text-primary) transition-colors hover:bg-app-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => void change("download_storage_choose")}
        >
          {moving ? "Moving downloads…" : "Change folder…"}
        </button>
        <button
          type="button"
          disabled={moving || !info}
          className="settings-choice inline-flex items-center gap-2 rounded-lg border border-(--border) bg-app-surface px-3 py-1.5 text-sm text-(--text-primary) transition-colors hover:bg-app-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() =>
            void invoke("download_storage_open").catch(() => {
              if (current.current) setError("Could not open the download folder.")
            })
          }
        >
          <IconFolderOpen size={16} aria-hidden="true" />
          Open folder
        </button>
      </div>
      <p className="text-xs leading-relaxed text-(--text-secondary)">
        Hibiki uses a dedicated Hibiki folder inside your chosen location.
        Existing downloads move with it; the temporary playback cache stays
        separate.
      </p>
      {moving && (
        <p role="status" className="text-sm text-(--text-secondary)">
          Finishing the current download and moving verified files. This can
          take a moment for a large collection.
        </p>
      )}
      {(error || info?.error) && (
        <div
          role="alert"
          className="space-y-2 text-sm text-(--text-primary)"
        >
          <p>{error || info?.error}</p>
          <button
            type="button"
            disabled={moving}
            className="settings-choice rounded-lg border border-(--border) bg-app-surface px-3 py-1.5 text-sm text-(--text-primary) transition-colors hover:bg-app-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void change("download_storage_retry")}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
