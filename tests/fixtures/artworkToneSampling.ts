import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
const dom = new JSDOM("<img id='cover'>", { url: "https://hibiki.test" })
globalThis.window = dom.window as any
globalThis.document = dom.window.document
globalThis.MutationObserver = dom.window.MutationObserver
const image = document.querySelector("img")!
Object.defineProperty(image, "complete", { value: true })
Object.defineProperty(image, "naturalWidth", { value: 64 })
let tainted = false,
  tooLarge = false,
  requests = 0,
  bitmaps = 0,
  closed = 0
const rgba = new Uint8ClampedArray(
  Array.from({ length: 576 }, () => [30, 190, 100, 255]).flat()
)
;(dom.window.HTMLCanvasElement.prototype as any).getContext = function () {
  assert.equal(this.width, 24)
  assert.equal(this.height, 24)
  return {
    drawImage(source: any) {
      if (source === image && tainted) throw Error("tainted")
    },
    getImageData() {
      return { data: rgba }
    },
  }
}
globalThis.fetch = (async (url: any, options: any) => {
  requests++
  assert.equal(url, image.getAttribute("src"))
  assert.equal(options.cache, "force-cache")
  const bytes = new Uint8Array(tooLarge ? 8 * 1024 * 1024 + 1 : 4)
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    { status: 200 }
  )
}) as any
globalThis.createImageBitmap = (async (blob: any, options: any) => {
  bitmaps++
  assert.equal(options.resizeWidth, 24)
  assert.equal(options.resizeHeight, 24)
  return {
    close() {
      closed++
    },
  }
}) as any
const { artworkToneSampler } = await import("../../src/lib/artworkTone")
image.src = "image://localhost/ext/img?scope=fixture&src=opaque"
assert(await artworkToneSampler.sample(image.getAttribute("src")!))
assert.equal(requests, 0)
tainted = true
image.src = "image://localhost/ext/img?scope=fixture&src=cached"
assert(await artworkToneSampler.sample(image.getAttribute("src")!))
assert.equal(requests, 1)
assert.equal(bitmaps, 1)
assert.equal(closed, 1)
tooLarge = true
image.src = "image://localhost/ext/img?scope=fixture&src=oversized"
assert.equal(await artworkToneSampler.sample(image.getAttribute("src")!), null)
assert.equal(bitmaps, 1)
image.src = "https://upstream.test/cover"
assert.equal(await artworkToneSampler.sample(image.getAttribute("src")!), null)
assert.equal(requests, 2, "tainted upstream must never be fetched")
tainted = false
const broken = document.createElement("img")
broken.src = "image://localhost/ext/img?scope=fixture&src=retry"
Object.defineProperty(broken, "complete", { value: false })
image.replaceWith(broken)
const retry = artworkToneSampler.sample(broken.getAttribute("src")!)
for (let i = 0; i < 5; i++) await Promise.resolve()
broken.dispatchEvent(new dom.window.Event("error"))
const recovered = document.createElement("img")
recovered.src = broken.src
Object.defineProperty(recovered, "complete", { value: true })
Object.defineProperty(recovered, "naturalWidth", { value: 64 })
broken.replaceWith(recovered)
assert(
  await retry,
  "replaced transient image attempt must still acquire a tone"
)
assert.equal(requests, 2)
dom.window.close()
