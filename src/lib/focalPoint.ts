import { useEffect, useState } from "react"
import { artworkFocusFromPixels, type FocalPoint } from "./artworkFocus"

const CENTER: FocalPoint = { x: 0.5, y: 0.5 }
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const ANALYSIS_TIMEOUT_MS = 15_000
const MAX_CACHED_POINTS = 256
const successfulPoints = new Map<string, FocalPoint>()

function cachedPoint(imageUrl: string): FocalPoint | null {
  const point = successfulPoints.get(imageUrl)
  if (!point) return null
  successfulPoints.delete(imageUrl)
  successfulPoints.set(imageUrl, point)
  return { ...point }
}

function cachePoint(imageUrl: string, point: FocalPoint) {
  successfulPoints.delete(imageUrl)
  successfulPoints.set(imageUrl, { ...point })
  if (successfulPoints.size > MAX_CACHED_POINTS)
    successfulPoints.delete(successfulPoints.keys().next().value!)
}

// Bound response bodies even when a server omits Content-Length.
async function imageBlob(response: Response): Promise<Blob | null> {
  if (
    !response.ok ||
    Number(response.headers.get("Content-Length")) > MAX_IMAGE_BYTES
  )
    return null
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: BlobPart[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.byteLength > MAX_IMAGE_BYTES - bytes) {
        await reader.cancel()
        return null
      }
      bytes += value.byteLength
      chunks.push(value)
    }
    return bytes
      ? new Blob(chunks, { type: response.headers.get("Content-Type") ?? "" })
      : null
  } finally {
    reader.releaseLock()
  }
}

/**
 * Find a local region of detail in a 100×100 sample. Reuse the loaded image when
 * supplied; only cached native protocol bytes may be read if its canvas is tainted.
 * Errors, cancellation, and stalled fetches/decodes use the supplied fallback.
 */
export function detectFocalPoint(
  imageUrl: string,
  signal?: AbortSignal,
  options?: { image: HTMLImageElement; timeoutMs: number; fallback: FocalPoint }
): Promise<FocalPoint> {
  const fallback = options?.fallback ?? CENTER
  if (signal?.aborted) return Promise.resolve(fallback)
  const cached = cachedPoint(imageUrl)
  if (cached) return Promise.resolve(cached)
  if (options?.image) {
    try {
      const point = analyzeFocalPoint(options.image)
      if (point) {
        cachePoint(imageUrl, point)
        return Promise.resolve(point)
      }
      return Promise.resolve(fallback)
    } catch {
      /* WKWebView custom-protocol canvases may be tainted. */
    }
    if (
      !/^image:\/\/localhost\//.test(imageUrl) &&
      !/^https?:\/\/image\.localhost\//.test(imageUrl)
    )
      return Promise.resolve(fallback)
  }
  return new Promise((resolve) => {
    const request = new AbortController()
    let image: HTMLImageElement | null = null
    let blobUrl: string | null = null
    let deadline: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (point: FocalPoint = fallback, succeeded = false) => {
      if (settled) return
      settled = true
      if (succeeded) cachePoint(imageUrl, point)
      if (deadline !== undefined) clearTimeout(deadline)
      signal?.removeEventListener("abort", cancel)
      request.abort()
      if (image) {
        image.onload = image.onerror = null
        image.removeAttribute("src")
      }
      if (blobUrl) URL.revokeObjectURL(blobUrl)
      resolve(point)
    }
    const cancel = () => finish()
    if (signal?.aborted) {
      finish()
      return
    }
    signal?.addEventListener("abort", cancel, { once: true })
    deadline = setTimeout(cancel, options?.timeoutMs ?? ANALYSIS_TIMEOUT_MS)
    void (async () => {
      try {
        const response = await fetch(imageUrl, {
          signal: request.signal,
          cache: "force-cache",
        })
        if (settled) return
        const blob = await imageBlob(response)
        if (settled) return
        if (!blob) {
          finish()
          return
        }
        blobUrl = URL.createObjectURL(blob)
        image = new Image()
        image.onload = () => {
          if (settled) return
          // Exceptions in image event handlers do not reach the fetch catch.
          try {
            const point = analyzeFocalPoint(image!)
            if (point) finish(point, true)
            else finish()
          } catch {
            finish()
          }
        }
        image.onerror = cancel
        image.src = blobUrl
      } catch {
        finish()
      }
    })()
  })
}

function analyzeFocalPoint(img: HTMLImageElement): FocalPoint | null {
  const SIZE = 100
  const canvas = document.createElement("canvas")
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) {
    return null
  }

  ctx.drawImage(img, 0, 0, SIZE, SIZE)
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE)

  return artworkFocusFromPixels(data, SIZE)
}

/**
 * React hook that asynchronously detects the focal point of an image and
 * formats source-space coordinates as percentages. Use artworkPlacement to
 * center that point; CSS background-position percentages have different semantics.
 *
 * Successful positions survive navigation in a bounded exact-URL cache.
 * New artwork uses "50% 50%" while loading; transient fallbacks are not cached.
 */
export function useFocalPoint(imageUrl: string | null): string {
  const savedPoint = imageUrl ? cachedPoint(imageUrl) : null
  const savedPosition = savedPoint
    ? `${Math.round(savedPoint.x * 100)}% ${Math.round(savedPoint.y * 100)}%`
    : null
  const [result, setResult] = useState<{
    imageUrl: string
    position: string
  } | null>(() =>
    imageUrl && savedPosition ? { imageUrl, position: savedPosition } : null
  )

  useEffect(() => {
    if (!imageUrl) return
    const controller = new AbortController()
    void detectFocalPoint(imageUrl, controller.signal).then(({ x, y }) => {
      if (!controller.signal.aborted) {
        setResult({
          imageUrl,
          position: `${Math.round(x * 100)}% ${Math.round(y * 100)}%`,
        })
      }
    })
    return () => controller.abort()
  }, [imageUrl])

  return imageUrl && result?.imageUrl === imageUrl
    ? result.position
    : (savedPosition ?? "50% 50%")
}
