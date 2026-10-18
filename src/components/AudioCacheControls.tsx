import { Button } from "./shared/Button"
import { Select } from "./shared/Select"
import { useEffect, useId, useRef, useState } from "react"
import type { AudioCacheStats } from "../audio/RustAudioEngine"

const GIB = 1024 ** 3
const OPTIONS = [1, 2, 5, 10, 20, 50].map((size) => ({
  bytes: size * GIB,
  label: `${size} GB`,
}))
OPTIONS.push({ bytes: 0, label: "Unlimited" })

export interface AudioCacheBackend {
  getCacheStats(): Promise<AudioCacheStats>
  clearCache(): Promise<AudioCacheStats>
}

function usage(bytes: number) {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function AudioCacheControls({
  backend,
  maximum,
  onMaximumChange,
}: {
  backend: AudioCacheBackend
  maximum: number
  onMaximumChange(bytes: number): Promise<AudioCacheStats>
}) {
  const [stats, setStats] = useState<AudioCacheStats | null>(null)
  const [pending, setPending] = useState<"clear" | "limit" | null>(null)
  const [error, setError] = useState<{
    kind: "load" | "mutation"
    message: string
  } | null>(null)
  const revision = useRef(0)
  const scope = useRef(0)
  const busy = useRef(false)
  const limitId = useId()

  useEffect(() => {
    const owner = ++scope.current
    let querying = false
    const refresh = async () => {
      if (querying || busy.current) return
      querying = true
      const at = revision.current
      try {
        const value = await backend.getCacheStats()
        if (scope.current === owner && revision.current === at) {
          setStats(value)
          setError((previous) => (previous?.kind === "load" ? null : previous))
        }
      } catch {
        if (scope.current === owner && revision.current === at)
          setError({
            kind: "load",
            message: "Could not load audio cache usage.",
          })
      } finally {
        querying = false
      }
    }
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 3000)
    return () => {
      clearInterval(timer)
      ++scope.current
    }
  }, [backend])

  async function change(kind: "clear" | "limit", bytes?: number) {
    if (busy.current) return
    busy.current = true
    const at = ++revision.current
    const owner = scope.current
    setPending(kind)
    setError(null)
    try {
      const value =
        kind === "clear"
          ? await backend.clearCache()
          : await onMaximumChange(bytes!)
      if (scope.current === owner && revision.current === at) setStats(value)
    } catch (reason) {
      if (scope.current === owner && revision.current === at) {
        const message =
          reason instanceof Error ? reason.message : String(reason)
        setError({
          kind: "mutation",
          message: `Could not ${kind === "clear" ? "clear the audio cache" : "change the cache limit"}: ${message}`,
        })
        // A partial deletion failure still needs an accurate visible count.
        void backend
          .getCacheStats()
          .then((value) => {
            if (scope.current === owner && revision.current === at)
              setStats(value)
          })
          .catch(() => {})
      }
    } finally {
      busy.current = false
      if (scope.current === owner && revision.current === at) setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={pending !== null}>
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">Cached Tracks</p>
          <p className="mt-0.5 text-xs text-white/40" aria-live="polite">
            {stats
              ? `${usage(stats.total_bytes)} · ${stats.file_count} ${stats.file_count === 1 ? "track" : "tracks"}`
              : error
                ? "Cache usage unavailable"
                : "Loading..."}
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            void change("clear")
          }}
          disabled={pending !== null || !stats || stats.total_bytes === 0}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-xs transition-colors hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending === "clear" ? "Clearing..." : "Clear"}
        </Button>
      </div>
      <div className="flex items-center gap-4">
        <label
          htmlFor={limitId}
          className="min-w-0 flex-1 text-sm font-medium text-white"
        >
          Max Cache Size
        </label>
        {pending === "limit" && (
          <span role="status" className="text-xs text-white/40">
            Updating...
          </span>
        )}
        <Select
          id={limitId}
          value={maximum}
          disabled={pending !== null}
          onChange={(event) => {
            void change("limit", Number(event.target.value))
          }}

        >
          {OPTIONS.map((option) => (
            <option key={option.bytes} value={option.bytes}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error.message}
        </p>
      )}
    </div>
  )
}
