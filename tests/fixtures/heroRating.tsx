import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { deferred } from "../helpers/radioAudioFakes"
const scenario = process.argv[2]
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
globalThis.window = dom.window as any
globalThis.document = dom.window.document
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const published: any[][] = []
mock.module("../../src/stores/libraryStore", () => ({
  useLibraryStore: {
    getState: () => ({ onItemRated: (...args: any[]) => published.push(args) }),
  },
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const requests: Array<{
  owner: string
  id: string
  value: number | null
  pending: ReturnType<typeof deferred<void>>
}> = []
function provider(owner: string) {
  return {
    cacheScope: owner,
    capabilities: { ratings: true },
    rate(id: string, value: number | null) {
      const pending = deferred<void>()
      requests.push({ owner, id, value, pending })
      return pending.promise
    },
  } as any
}
const first = provider("first")
useProviderStore.getState().setProvider(first)
const { HeroRating } = await import("../../src/components/HeroRating")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
let id = "one",
  rating: number | null = 4
async function flush() {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}
async function render() {
  await act(async () => {
    root.render(<HeroRating itemId={id} userRating={rating} itemType="album" />)
    await flush()
  })
}
const star = (value: number) =>
  document.querySelector<HTMLButtonElement>(
    `button[aria-label="${value} star${value > 1 ? "s" : ""}"]`
  )!
async function click(value: number) {
  await act(async () => {
    star(value).click()
    await flush()
  })
}
async function settle(index: number, fail = false) {
  await act(async () => {
    fail
      ? requests[index].pending.reject(new Error("private failed request"))
      : requests[index].pending.resolve()
    await flush()
  })
}
await render()
assert.equal(star(2).getAttribute("aria-pressed"), "true")
const clear = document.querySelector<HTMLButtonElement>(
  '[aria-label="Clear rating"]'
)!
assert.match(clear.className, /focus-visible:opacity-100/)
assert.match(star(5).className, /text-\(--text-muted\)/)
if (scenario === "capabilities") {
  await act(async () =>
    useProviderStore.setState({ capabilities: { ratings: false } as any })
  )
  assert.equal(document.querySelectorAll("button").length, 0)
  await act(async () =>
    useProviderStore.setState({ capabilities: { ratings: true } as any })
  )
  assert.equal(star(2).getAttribute("aria-pressed"), "true")
  await click(4)
  await settle(0)
  assert.deepEqual(published, [["one", "album", 8]])
} else if (scenario === "item") {
  await click(5)
  id = "two"
  rating = 2
  await render()
  assert.equal(star(1).getAttribute("aria-pressed"), "true")
  await click(3)
  await settle(0, true)
  assert.equal(star(3).getAttribute("aria-pressed"), "true")
  assert.equal(star(3).disabled, true)
  await settle(1)
  assert.deepEqual(published, [["two", "album", 6]])
} else if (scenario === "provider") {
  await click(5)
  await act(async () =>
    useProviderStore.getState().setProvider(provider("second"))
  )
  assert.equal(star(2).getAttribute("aria-pressed"), "true")
  await click(3)
  await settle(0)
  assert.equal(star(3).getAttribute("aria-pressed"), "true")
  assert.deepEqual(published, [])
  await settle(1)
  assert.deepEqual(published, [["one", "album", 6]])
} else if (scenario === "scope") {
  await click(5)
  first.cacheScope = "replacement"
  await render()
  assert.equal(star(2).getAttribute("aria-pressed"), "true")
  await click(3)
  await settle(0)
  assert.equal(star(3).getAttribute("aria-pressed"), "true")
  assert.deepEqual(published, [])
  await settle(1)
  assert.deepEqual(published, [["one", "album", 6]])
} else if (scenario === "rapid") {
  await act(async () => {
    star(5).click()
    star(3).click()
    clear.click()
    await flush()
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].value, 10)
  assert.equal(star(5).disabled, true)
  await settle(0, true)
  assert.equal(star(2).getAttribute("aria-pressed"), "true")
  assert.equal(star(5).disabled, false)
  await click(3)
  await settle(1)
  assert.deepEqual(published, [["one", "album", 6]])
} else if (scenario === "unmount") {
  await click(5)
  await act(async () => root.unmount())
  await settle(0, true)
  assert.deepEqual(published, [])
} else throw Error("unknown scenario")
if (scenario !== "unmount") await act(async () => root.unmount())
