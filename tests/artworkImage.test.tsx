import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { ArtworkImage, useArtworkFailures } from "../src/components/shared/ArtworkImage"
const dom = new JSDOM("<div id='root'></div>")
const previous = { document: globalThis.document, window: globalThis.window, timeout: globalThis.setTimeout, clear: globalThis.clearTimeout, act: (globalThis as any).IS_REACT_ACT_ENVIRONMENT }
let root: Root
let nextId = 0
let timers: Map<number, { run: () => void; delay: number }>
let failed: string[]
async function render(src = "image://localhost/album/fixture?src=fixture") {
  await act(() => root.render(<ArtworkImage src={src} className="cover" onFailure={url => failed.push(url)} />))
}
async function error() { await act(() => document.querySelector("img")!.dispatchEvent(new dom.window.Event("error"))) }
async function retry() {
  const [id, timer] = [...timers][0]
  timers.delete(id)
  await act(timer.run)
}
beforeEach(() => {
  globalThis.document = dom.window.document
  globalThis.window = dom.window as unknown as Window & typeof globalThis
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  timers = new Map()
  failed = []
  globalThis.setTimeout = ((run: () => void, delay: number) => { timers.set(++nextId, { run, delay }); return nextId }) as any
  globalThis.clearTimeout = ((id: number) => timers.delete(id)) as any
  root = createRoot(document.getElementById("root")!)
})
afterEach(async () => { await act(() => root.unmount()); globalThis.setTimeout = previous.timeout; globalThis.clearTimeout = previous.clear })
afterAll(() => { globalThis.document = previous.document; globalThis.window = previous.window; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act; dom.window.close() })
test("gallery art loads lazily and retries admission failure twice before failing over", async () => {
  await render()
  expect(document.querySelector("img")!.getAttribute("loading")).toBe("lazy")
  const initial = document.querySelector("img")
  await error()
  await error()
  expect(timers.size).toBe(1)
  expect([...timers.values()][0].delay).toBeGreaterThanOrEqual(1000)
  expect(failed).toEqual([])
  await retry()
  expect(document.querySelector("img")).not.toBe(initial)
  await error()
  expect([...timers.values()][0].delay).toBeGreaterThanOrEqual(2000)
  await retry()
  await error()
  expect(failed).toEqual(["image://localhost/album/fixture?src=fixture"])
  expect(timers.size).toBe(0)
  expect(document.querySelector("img")).toBeNull()
})
test("source change cancels the old retry and restores its own retry budget", async () => {
  await render("old")
  await error()
  await render("new")
  expect(timers.size).toBe(0)
  await error()
  expect(timers.size).toBe(1)
  await act(() => root.unmount())
  expect(timers.size).toBe(0)
})
test("failed-source state resets synchronously when an entity or Plex scope changes", async () => {
  function Harness({ scope }: { scope: string }) {
    const { failures, onFailure } = useArtworkFailures(scope)
    return <button onClick={() => onFailure("broken")}>{failures.join(",")}</button>
  }
  await act(() => root.render(<Harness scope="account-one:album" />))
  await act(() => document.querySelector("button")!.click())
  expect(document.querySelector("button")!.textContent).toBe("broken")
  await act(() => root.render(<Harness scope="account-two:album" />))
  expect(document.querySelector("button")!.textContent).toBe("")
})
test("a successful load cancels an already scheduled retry", async () => {
  await render()
  await error()
  expect(timers.size).toBe(1)
  expect(document.querySelector("img")!.style.visibility).toBe("hidden")
  await act(() => document.querySelector("img")!.dispatchEvent(new dom.window.Event("load")))
  expect(document.querySelector("img")!.style.visibility).toBe("")
  expect(timers.size).toBe(0)
  expect(failed).toEqual([])
})
test("hidden banner detectors remain hidden after retry exhaustion", async () => {
  const style = document.createElement("style")
  style.textContent = ".block { display: block; } .hidden { display: none; }"
  document.head.append(style)
  try {
    await act(() => root.render(<ArtworkImage src="banner" className="hidden" loading="eager" />))
    await error(); await retry(); await error(); await retry(); await error()
    const placeholder = document.querySelector("span")!
    expect(dom.window.getComputedStyle(placeholder).display).toBe("none")
    expect(placeholder.style.display).toBe("")
  } finally { style.remove() }
})
