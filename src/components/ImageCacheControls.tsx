import { Button } from "./shared/Button"
import { useEffect, useRef, useState } from "react"
import {
  clearImageCache,
  getImageCacheInfo,
  type ImageCacheInfo,
} from "../lib/imageCache"

export interface ImageCacheBackend {
  getInfo(): Promise<ImageCacheInfo>
  clear(): Promise<ImageCacheInfo>
}
const nativeCache: ImageCacheBackend = {
  getInfo: getImageCacheInfo,
  clear: clearImageCache,
}
const size = (bytes: number) => {
  if (!bytes) return "0 B"
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** unit).toFixed(1)} ${["B", "KB", "MB", "GB"][unit]}`
}

export function ImageCacheControls({
  backend = nativeCache,
}: {
  backend?: ImageCacheBackend
}) {
  const [info, setInfo] = useState<ImageCacheInfo | null>(null)
  const [pending, setPending] = useState<"loading" | "clearing" | null>(
    "loading"
  )
  const [error, setError] = useState<{
    message: string
    clear: boolean
  } | null>(null)
  const generation = useRef(0)

  async function request(clear = false) {
    const ticket = ++generation.current
    setPending(clear ? "clearing" : "loading")
    setError(null)
    try {
      const result = await (clear ? backend.clear() : backend.getInfo())
      if (generation.current === ticket) setInfo(result)
    } catch (failure) {
      if (generation.current !== ticket) return
      setError({
        message: failure instanceof Error ? failure.message : String(failure),
        clear,
      })
      setInfo(null)
      // A failed clear can still have removed some files. Show actual stats
      // when available, retaining the error so the user can retry.
      if (clear) {
        try {
          const current = await backend.getInfo()
          if (generation.current === ticket) setInfo(current)
        } catch {
          /* The original operation error is the useful one. */
        }
      }
    } finally {
      if (generation.current === ticket) setPending(null)
    }
  }

  useEffect(() => {
    setInfo(null)
    void request()
    return () => {
      ++generation.current
    }
  }, [backend])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">Cached Images</p>
          <p
            role="status"
            aria-live="polite"
            className="mt-0.5 text-xs text-white/60"
          >
            {pending === "loading"
              ? "Loading..."
              : info
                ? `${size(info.bytes)} · ${info.files} ${info.files === 1 ? "file" : "files"}`
                : "Image cache unavailable"}
          </p>
          {info && (
            <p className="mt-1 text-xs text-white/60">
              Keeps recently used images, up to {size(info.max_bytes)} or{" "}
              {info.max_files.toLocaleString()} files.
            </p>
          )}
        </div>
        <Button
          variant="bare"
          type="button"
          aria-label="Clear image cache"
          onClick={() => void request(true)}
          disabled={pending !== null || !info?.files}
          className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending === "clearing" ? "Clearing..." : "Clear"}
        </Button>
      </div>
      {error && (
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="text-xs text-red-300">
            {error.message}
          </p>
          <Button
            variant="secondary"
            type="button"
            disabled={pending !== null}
            onClick={() => void request(error.clear)}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs disabled:opacity-40"
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  )
}
