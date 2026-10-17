import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import { deferred } from "../helpers/radioAudioFakes"

const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import("react-dom/client")
const providerStore = create(() => ({ provider: null as any }))
let invalidations = 0
mock.module("../../src/stores/providerStore", () => ({ useProviderStore: providerStore }))
mock.module("../../src/stores/libraryStore", () => ({ useLibraryStore: create(() => ({ invalidateCache: () => invalidations++ })) }))
mock.module("../../src/stores/uiStore", () => ({ useUIStore: create(() => ({ incrementPageRefreshKey() {} })) }))
const { LibraryCacheControls } = await import("../../src/components/LibraryCacheControls")
const root = createRoot(document.getElementById("root")!)
const stats = { collections: 8, items: 1200, snapshots: 40, bytes: 2*1024*1024 }
let pending = deferred<void>(), fail = true
const provider = {
  cacheScope: "a", playbackSession: {}, getLibraryCacheInfo: async () => stats,
  clearLibraryCache: async () => { await pending.promise; if (fail) throw Error("disk unavailable") },
}
providerStore.setState({ provider })
await act(async () => root.render(<LibraryCacheControls />))
const button = () => document.querySelector("button")!
assert(document.body.textContent?.includes("1,200 items"))
await act(async () => button().click())
assert(button().disabled)
assert.equal(invalidations, 0)
await act(async () => pending.resolve())
assert(document.querySelector('[role="alert"]')?.textContent?.includes("Try again"))
assert(!button().disabled)
assert.equal(invalidations, 0)
pending = deferred<void>(); fail = false
await act(async () => button().click())
await act(async () => pending.resolve())
assert.equal(invalidations, 1)
assert(!document.querySelector('[role="alert"]'))
pending = deferred<void>()
await act(async () => button().click())
await act(async () => providerStore.setState({ provider: { ...provider, cacheScope: "b", getLibraryCacheInfo: async () => ({ ...stats, items: 99 }) } }))
await act(async () => pending.resolve())
assert.equal(invalidations, 1, "an old clear cannot invalidate the next library")
assert(document.body.textContent?.includes("99 items"))
await act(async () => root.unmount())
dom.window.close()
