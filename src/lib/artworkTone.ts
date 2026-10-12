export interface ArtworkTone {
  primary: string
  primaryRgb: string
  ink: string
  secondary: string
  secondaryRgb: string
}
type RGB = [number, number, number]
function hsl(rgb: RGB): [number, number, number] {
  const [r, g, b] = rgb.map((value) => value / 255)
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2,
    d = max - min
  if (!d) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h =
    max === r
      ? (g - b) / d + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4
  return [h * 60, s, l]
}
function rgb(h: number, s: number, l: number): RGB {
  const chroma = (1 - Math.abs(2 * l - 1)) * s,
    sector = (((h % 360) + 360) % 360) / 60
  const x = chroma * (1 - Math.abs((sector % 2) - 1)),
    m = l - chroma / 2
  const channels =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x]
  return channels.map((value) => Math.round((value + m) * 255)) as RGB
}
export function artworkContrast(a: RGB, b: RGB): number {
  const luminance = (color: RGB) =>
    color
      .map((value) => {
        const v = value / 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
      .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0)
  const first = luminance(a),
    second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}
/** Heya's saturated-third color identity, bounded to one 24×24 RGBA sample. */
export function artworkToneFromPixels(
  data: ArrayLike<number>
): ArtworkTone | null {
  if (data.length !== 24 * 24 * 4) return null
  const pixels: Array<{ color: RGB; saturation: number }> = []
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const color = [data[i], data[i + 1], data[i + 2]] as RGB
    if (
      color.some((value) => !Number.isFinite(value) || value < 0 || value > 255)
    )
      return null
    pixels.push({ color, saturation: Math.max(...color) - Math.min(...color) })
  }
  if (!pixels.length) return null
  pixels.sort((a, b) => b.saturation - a.saturation)
  const count = Math.max(1, Math.floor(pixels.length / 3)),
    average: RGB = [0, 0, 0]
  for (const pixel of pixels.slice(0, count))
    for (let i = 0; i < 3; i++) average[i] += pixel.color[i] / count
  let [h, s, l] = hsl(average)
  s = Math.min(0.85, Math.max(0.4, s * 1.15))
  l = Math.min(0.58, Math.max(0.38, l))
  const dark: RGB = [11, 11, 12],
    white: RGB = [255, 255, 255]
  let primary = rgb(h, s, l)
  // Near-black has a narrow crossover where neither ink reaches 4.5. Lift
  // lightness minimally there instead of accepting unreadable text.
  for (
    let step = 0;
    step < 32 &&
    Math.max(artworkContrast(primary, dark), artworkContrast(primary, white)) <
      4.5;
    step++
  )
    primary = rgb(h, s, (l += 0.002))
  const ink =
    artworkContrast(primary, dark) >= artworkContrast(primary, white)
      ? "#0b0b0c"
      : "#ffffff"
  const secondary = rgb(h + 180, s, l)
  return {
    primary: `rgb(${primary.join(" ")})`,
    primaryRgb: primary.join(" "),
    ink,
    secondary: `rgb(${secondary.join(" ")})`,
    secondaryRgb: secondary.join(" "),
  }
}

/** Three workers, deduplicated exact scoped URLs, bounded successful LRU. */
export function createArtworkToneSampler(
  sample: (url: string) => Promise<ArtworkTone | null>,
  limit = 128
) {
  const cache = new Map<string, ArtworkTone>(),
    pending = new Map<string, Promise<ArtworkTone | null>>()
  const waiting: Array<() => void> = []
  let workers = 0
  const peek = (url: string) => {
    const value = cache.get(url)
    if (value) {
      cache.delete(url)
      cache.set(url, value)
    }
    return value
  }
  return {
    peek,
    sample(url: string, key = url): Promise<ArtworkTone | null> {
      const saved = peek(key)
      if (saved) return Promise.resolve(saved)
      if (pending.size >= 256 && !pending.has(key)) return Promise.resolve(null)
      const existing = pending.get(key)
      if (existing) return existing
      const request = new Promise<ArtworkTone | null>((resolve) => {
        const run = () => {
          ++workers
          void Promise.resolve()
            .then(() => sample(url))
            .catch(() => null)
            .then((tone) => {
              if (tone) {
                cache.set(key, tone)
                if (cache.size > limit) cache.delete(cache.keys().next().value!)
              }
              pending.delete(key)
              --workers
              waiting.shift()?.()
              resolve(tone)
            })
        }
        if (workers < 3) run()
        else waiting.push(run)
      })
      pending.set(key, request)
      return request
    },
  }
}

function cachedImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    let image: HTMLImageElement | null = null
    const finish = (result: HTMLImageElement | null) => {
      clearTimeout(timer)
      observer.disconnect()
      image?.removeEventListener("load", loaded)
      image?.removeEventListener("error", failed)
      resolve(result)
    }
    const loaded = () =>
        finish(
          image?.naturalWidth &&
            (image.getAttribute("src") === url || image.currentSrc === url)
            ? image
            : null
        ),
      failed = () => {
        /* ArtworkImage may replace the failed attempt before the deadline. */
      }
    const find = () => {
      const next = [...document.images].find(
        (candidate) =>
          candidate.getAttribute("src") === url || candidate.currentSrc === url
      )
      if (!next || next === image) return
      image?.removeEventListener("load", loaded)
      image?.removeEventListener("error", failed)
      image = next
      if (image.complete && image.naturalWidth) {
        finish(image)
        return
      }
      image.addEventListener("load", loaded)
      image.addEventListener("error", failed)
    }
    const timer = setTimeout(() => finish(null), 5000)
    const observer = new MutationObserver(find)
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    })
    find()
  })
}
function fromSource(source: CanvasImageSource): ArtworkTone | null {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 24
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) return null
  context.drawImage(source, 0, 0, 24, 24)
  return artworkToneFromPixels(context.getImageData(0, 0, 24, 24).data)
}
async function sampleDisplayedArtwork(
  url: string
): Promise<ArtworkTone | null> {
  if (typeof document === "undefined") return null
  const image = await cachedImage(url)
  if (!image) return null
  try {
    return fromSource(image)
  } catch {
    /* Custom protocol canvas may require same-URL cached bytes. */
  }
  // Never fetch an upstream source, rewrite its size, or bypass the cache.
  if (
    !/^image:\/\/localhost\//.test(url) &&
    !/^https?:\/\/image\.localhost\//.test(url)
  )
    return null
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 5000)
  let bitmap: ImageBitmap | null = null
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "force-cache",
    })
    if (
      !response.ok ||
      Number(response.headers.get("Content-Length")) > 8 * 1024 * 1024
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
        bytes += value.byteLength
        if (bytes > 8 * 1024 * 1024) {
          await reader.cancel()
          return null
        }
        chunks.push(new Uint8Array(value).buffer)
      }
    } finally {
      reader.releaseLock()
    }
    if (!bytes || controller.signal.aborted) return null
    bitmap = await createImageBitmap(new Blob(chunks), {
      resizeWidth: 24,
      resizeHeight: 24,
      resizeQuality: "low",
    })
    if (controller.signal.aborted) return null
    return fromSource(bitmap)
  } catch {
    return null
  } finally {
    bitmap?.close()
    clearTimeout(timer)
  }
}
export const artworkToneSampler = createArtworkToneSampler(
  sampleDisplayedArtwork
)
