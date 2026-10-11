import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { detectFocalPoint, useFocalPoint } from "../src/lib/focalPoint"

const dom = new JSDOM("<div id='root'></div>")
const previous = {
  document: globalThis.document,
  window: globalThis.window,
  image: globalThis.Image,
  fetch: globalThis.fetch,
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
  timeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  act: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
}
globalThis.document = dom.window.document
globalThis.window = dom.window as unknown as Window & typeof globalThis
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const center = { x: 0.5, y: 0.5 }
const images: FakeImage[] = []
const created: string[] = []
const revoked: string[] = []
const deadlines = new Map<number, () => void>()
const requests: AbortSignal[] = []
let root: Root | null = null
let throwCanvas = false
let missingCanvas = false
let pixels: Uint8ClampedArray
let timerId = 0

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  src = ""
  constructor() {
    images.push(this)
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = ""
  }
}
function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function flush() {
  for (let step = 0; step < 10; step++) await Promise.resolve()
}
function imageResponse() {
  return new Response(new Uint8Array([1, 2, 3]), {
    headers: { "Content-Type": "image/png" },
  })
}
function Harness({
  url,
  onRender,
}: {
  url: string | null
  onRender?: (position: string) => void
}) {
  const position = useFocalPoint(url)
  onRender?.(position)
  return <output>{position}</output>
}

beforeEach(() => {
  images.length = created.length = revoked.length = requests.length = 0
  deadlines.clear()
  throwCanvas = false
  missingCanvas = false
  pixels = new Uint8ClampedArray(100 * 100 * 4)
  // A bright feature in the upper right should pull the crop toward it.
  for (let y = 20; y < 40; y++) {
    for (let x = 65; x < 85; x++) {
      const offset = (y * 100 + x) * 4
      pixels.set([255, 255, 255, 255], offset)
    }
  }
  globalThis.Image = FakeImage as unknown as typeof Image
  globalThis.fetch = (async (_url, options) => {
    requests.push(options?.signal as AbortSignal)
    return imageResponse()
  }) as typeof fetch
  URL.createObjectURL = () => {
    const url = `blob:fixture-${created.length}`
    created.push(url)
    return url
  }
  URL.revokeObjectURL = (url) => {
    revoked.push(url)
  }
  globalThis.setTimeout = ((callback: () => void) => {
    deadlines.set(++timerId, callback)
    return timerId
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    deadlines.delete(id)
  }) as unknown as typeof clearTimeout
  dom.window.HTMLCanvasElement.prototype.getContext = (() =>
    missingCanvas
      ? null
      : {
          drawImage() {
            if (throwCanvas) throw new Error("Canvas unavailable")
          },
          getImageData() {
            return { data: pixels }
          },
        }) as any
})
afterEach(async () => {
  if (root) {
    await act(() => root!.unmount())
    root = null
  }
  globalThis.fetch = previous.fetch
  globalThis.Image = previous.image
  URL.createObjectURL = previous.create
  URL.revokeObjectURL = previous.revoke
  globalThis.setTimeout = previous.timeout
  globalThis.clearTimeout = previous.clearTimeout
  expect(deadlines.size).toBe(0)
  expect(revoked).toEqual(created)
})
afterAll(() => {
  globalThis.document = previous.document
  globalThis.window = previous.window
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act
  dom.window.close()
})

test("canvas failures settle the crop and release the decoded image", async () => {
  throwCanvas = true
  const result = detectFocalPoint("image://localhost/artist/first")
  await flush()
  images[0].onload!()
  expect(await result).toEqual(center)
  expect(images[0].onload).toBeNull()
  expect(images[0].src).toBe("")
})

test("cancelling either fetch or decoding settles without retaining artwork", async () => {
  const response = pending<Response>()
  globalThis.fetch = ((_url, options) => {
    requests.push(options?.signal as AbortSignal)
    return response.promise
  }) as typeof fetch
  const controller = new AbortController()
  const result = detectFocalPoint(
    "image://localhost/artist/first",
    controller.signal
  )
  controller.abort()
  expect(await result).toEqual(center)
  expect(requests[0].aborted).toBe(true)
  response.resolve(imageResponse())
  await flush()
  expect(images).toHaveLength(0)
  expect(created).toHaveLength(0)

  globalThis.fetch = (async () => imageResponse()) as typeof fetch
  const decoding = new AbortController()
  const decoded = detectFocalPoint(
    "image://localhost/artist/second",
    decoding.signal
  )
  await flush()
  expect(images).toHaveLength(1)
  decoding.abort()
  expect(await decoded).toEqual(center)
  expect(images[0].onload).toBeNull()
})

test("a stalled request times out and ignores its late response", async () => {
  const response = pending<Response>()
  globalThis.fetch = ((_url, options) => {
    requests.push(options?.signal as AbortSignal)
    return response.promise
  }) as typeof fetch
  const result = detectFocalPoint("image://localhost/artist/first")
  expect(deadlines.size).toBe(1)
  for (const callback of [...deadlines.values()]) callback()
  expect(await result).toEqual(center)
  expect(requests[0].aborted).toBe(true)
  response.resolve(imageResponse())
  await flush()
  expect(created).toHaveLength(0)
})

test("failed HTTP responses and oversized streams never reach the decoder", async () => {
  globalThis.fetch = (async () =>
    new Response("not an image", { status: 404 })) as typeof fetch
  expect(await detectFocalPoint("image://localhost/artist/missing")).toEqual(
    center
  )
  let cancelled = false
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1))
        },
        cancel() {
          cancelled = true
        },
      })
    )) as typeof fetch
  expect(await detectFocalPoint("image://localhost/artist/large")).toEqual(
    center
  )
  expect(cancelled).toBe(true)
  expect(images).toHaveLength(0)
})

test("saliency still follows a visible feature and blank artwork uses the center", async () => {
  const result = detectFocalPoint("image://localhost/artist/feature")
  await flush()
  images[0].onload!()
  const point = await result
  expect(point.x).toBeGreaterThan(0.65)
  expect(point.x).toBeLessThan(0.85)
  expect(point.y).toBeGreaterThan(0.2)
  expect(point.y).toBeLessThan(0.4)
  pixels.fill(0)
  const blank = detectFocalPoint("image://localhost/artist/blank")
  await flush()
  images[1].onload!()
  expect(await blank).toEqual(center)
})

test("changing artist centers the new artwork immediately and cancels old analysis", async () => {
  root = createRoot(document.getElementById("root")!)
  await act(async () => {
    root!.render(<Harness url="image://localhost/artist/first" />)
    await flush()
  })
  await act(async () => {
    images[0].onload!()
    await flush()
  })
  expect(document.querySelector("output")!.textContent).not.toBe("50% 50%")
  await act(async () => {
    root!.render(<Harness url="image://localhost/artist/second" />)
    await flush()
  })
  expect(document.querySelector("output")!.textContent).toBe("50% 50%")
  const lateLoad = images[1].onload!
  await act(async () => {
    root!.render(<Harness url="image://localhost/artist/third" />)
    await flush()
  })
  expect(requests[1].aborted).toBe(true)
  expect(images[1].onload).toBeNull()
  await act(async () => {
    lateLoad()
    await flush()
  })
  expect(document.querySelector("output")!.textContent).toBe("50% 50%")
  await act(async () => {
    images[2].onload!()
    await flush()
  })
  expect(document.querySelector("output")!.textContent).not.toBe("50% 50%")
})

test("successful artwork analysis survives navigation without a centered first paint or another decode", async () => {
  const url = "image://localhost/artist/remount-success"
  root = createRoot(document.getElementById("root")!)
  await act(async () => {
    root!.render(<Harness url={url} />)
    await flush()
  })
  await act(async () => {
    images[0].onload!()
    await flush()
  })
  const expected = document.querySelector("output")!.textContent!
  expect(expected).not.toBe("50% 50%")
  await act(() => root!.unmount())
  root = createRoot(document.getElementById("root")!)
  const rendered: string[] = []
  await act(async () => {
    root!.render(
      <Harness url={url} onRender={(position) => rendered.push(position)} />
    )
    await flush()
  })
  expect(rendered.length).toBeGreaterThan(0)
  expect(rendered.every((position) => position === expected)).toBe(true)
  expect(requests).toHaveLength(1)
  expect(images).toHaveLength(1)
  // Changing the existing hook to a cached URL also uses it during the render,
  // rather than briefly returning the previous entity's position or the center.
  await act(async () => {
    root!.render(<Harness url={null} />)
    await flush()
  })
  rendered.length = 0
  await act(async () => {
    root!.render(
      <Harness url={url} onRender={(position) => rendered.push(position)} />
    )
    await flush()
  })
  expect(rendered.every((position) => position === expected)).toBe(true)
  expect(requests).toHaveLength(1)
})

test("a transient analysis failure is retried rather than cached as a successful center", async () => {
  const url = "image://localhost/artist/transient-retry"
  throwCanvas = true
  const failed = detectFocalPoint(url)
  await flush()
  images[0].onload!()
  expect(await failed).toEqual(center)
  throwCanvas = false
  const retry = detectFocalPoint(url)
  await flush()
  images[1].onload!()
  const point = await retry
  expect(point.x).toBeGreaterThan(0.65)
  expect(requests).toHaveLength(2)
  expect(await detectFocalPoint(url)).toEqual(point)
  expect(requests).toHaveLength(2)
  const canceled = new AbortController()
  canceled.abort()
  expect(await detectFocalPoint(url, canceled.signal)).toEqual(center)
})

test("an unavailable canvas does not poison later analysis of the same image", async () => {
  const url = "image://localhost/artist/missing-canvas-retry"
  missingCanvas = true
  const failed = detectFocalPoint(url)
  await flush()
  images[0].onload!()
  expect(await failed).toEqual(center)
  missingCanvas = false
  const retry = detectFocalPoint(url)
  await flush()
  images[1].onload!()
  expect((await retry).x).toBeGreaterThan(0.65)
  expect(requests).toHaveLength(2)
})

test("successful focal-point cache is bounded and retains recently used URLs", async () => {
  for (let index = 0; index < 257; index++) {
    const result = detectFocalPoint(`image://localhost/artist/lru-${index}`)
    await flush()
    images.at(-1)!.onload!()
    await result
  }
  const count = requests.length
  await detectFocalPoint("image://localhost/artist/lru-256")
  await detectFocalPoint("image://localhost/artist/lru-1")
  expect(requests).toHaveLength(count)
  const evicted = detectFocalPoint("image://localhost/artist/lru-0")
  await flush()
  expect(requests).toHaveLength(count + 1)
  images.at(-1)!.onload!()
  await evicted
  await detectFocalPoint("image://localhost/artist/lru-1")
  expect(requests).toHaveLength(count + 1)
})
