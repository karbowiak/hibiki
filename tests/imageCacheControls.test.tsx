import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  ImageCacheControls,
  type ImageCacheBackend,
} from "../src/components/ImageCacheControls"
import type { ImageCacheInfo } from "../src/lib/imageCache"

const dom = new JSDOM("<div id='root'></div>")
const previous = {
  document: globalThis.document,
  window: globalThis.window,
  act: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
}
globalThis.document = dom.window.document
globalThis.window = dom.window as unknown as Window & typeof globalThis
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null
const info = (files = 2): ImageCacheInfo => ({
  files,
  bytes: files * 1024,
  max_bytes: 512 * 1024 * 1024,
  max_files: 4096,
})
const clearButton = () =>
  document.querySelector<HTMLButtonElement>('[aria-label="Clear image cache"]')!
const retryButton = () =>
  [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry"
  )!
const status = () => document.querySelector('[role="status"]')!.textContent!
const error = () => document.querySelector('[role="alert"]')?.textContent
function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
async function settle(action: () => unknown) {
  await act(async () => {
    action()
    for (let step = 0; step < 10; step++) await Promise.resolve()
  })
}
async function click(button: HTMLButtonElement) {
  await settle(() =>
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
  )
}
beforeEach(() => {
  root = createRoot(document.getElementById("root")!)
})
afterEach(async () => {
  if (root) await settle(() => root!.unmount())
})
afterAll(() => {
  globalThis.document = previous.document
  globalThis.window = previous.window
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act
  dom.window.close()
})

test("image cache read failures are visible and Retry reloads without clearing", async () => {
  let reads = 0
  let clears = 0
  const backend: ImageCacheBackend = {
    async getInfo() {
      if (++reads === 1) throw new Error("Cache is in use")
      return info()
    },
    async clear() {
      ++clears
      return info(0)
    },
  }
  await settle(() => root!.render(<ImageCacheControls backend={backend} />))
  expect(error()).toBe("Cache is in use")
  expect(status()).toBe("Image cache unavailable")
  expect(clearButton().disabled).toBe(true)
  await click(retryButton())
  expect(reads).toBe(2)
  expect(clears).toBe(0)
  expect(error()).toBeUndefined()
  expect(status()).toContain("2 files")
  expect(document.body.textContent).toContain("512.0 MB")
})

test("Clear stays pending until native completion and uses the acknowledged stats", async () => {
  let reads = 0
  let clears = 0
  const result = pending<ImageCacheInfo>()
  const backend: ImageCacheBackend = {
    async getInfo() {
      ++reads
      return info()
    },
    clear() {
      ++clears
      return result.promise
    },
  }
  await settle(() => root!.render(<ImageCacheControls backend={backend} />))
  await click(clearButton())
  expect(clearButton().disabled).toBe(true)
  expect(clearButton().textContent).toBe("Clearing...")
  expect(status()).toContain("2 files")
  await click(clearButton())
  expect(clears).toBe(1)
  await settle(() => result.resolve(info(0)))
  expect(status()).toBe("0 B · 0 files")
  expect(reads).toBe(1)
  expect(clearButton().disabled).toBe(true)
})

test("a partial clear failure refreshes actual stats and Retry repeats Clear", async () => {
  let reads = 0
  let clears = 0
  const backend: ImageCacheBackend = {
    async getInfo() {
      return info(++reads === 1 ? 2 : 1)
    },
    async clear() {
      if (++clears === 1) throw new Error("One file could not be removed")
      return info(0)
    },
  }
  await settle(() => root!.render(<ImageCacheControls backend={backend} />))
  await click(clearButton())
  expect(error()).toBe("One file could not be removed")
  expect(status()).toContain("1 file")
  expect(reads).toBe(2)
  await click(retryButton())
  expect(clears).toBe(2)
  expect(error()).toBeUndefined()
  expect(status()).toBe("0 B · 0 files")
})

test("a late cache read cannot overwrite a replacement backend", async () => {
  const old = pending<ImageCacheInfo>()
  const backend = { getInfo: () => old.promise, clear: async () => info(0) }
  await settle(() => root!.render(<ImageCacheControls backend={backend} />))
  expect(status()).toBe("Loading...")
  await settle(() =>
    root!.render(
      <ImageCacheControls
        backend={{ getInfo: async () => info(3), clear: async () => info(0) }}
      />
    )
  )
  await settle(() => old.resolve(info(99)))
  expect(status()).toContain("3 files")
})

test("unmounting retires late Clear failures without requesting more stats", async () => {
  const old = pending<ImageCacheInfo>()
  let reads = 0
  const backend = {
    getInfo: async () => {
      ++reads
      return info()
    },
    clear: () => old.promise,
  }
  await settle(() => root!.render(<ImageCacheControls backend={backend} />))
  await click(clearButton())
  await settle(() => root!.unmount())
  root = null
  await settle(() => old.reject(new Error("late failure")))
  expect(reads).toBe(1)
  expect(document.querySelector("button")).toBeNull()
})
