import assert from "node:assert/strict"
import { mock } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
const dom = new JSDOM("<div id='root'></div>", { url: "https://synthetic.test" })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })
mock.module("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw Error("No native writes in the fixture") } }))
const { createRoot } = await import("react-dom/client")
const { PlexArtworkPanel } = await import("../../src/components/shared/PlexArtworkPanel")
const { useProviderStore } = await import("../../src/stores/providerStore")
const root = createRoot(document.getElementById("root")!)
const inventory = { baseline: "verified-snapshot", candidates: [
  { id: "current", sourceUrl: null, label: "Current Plex image", selected: true },
  { id: "alternative", sourceUrl: null, label: "Alternate Plex image", selected: false },
] }
let reads = 0, writes: any[] = [], saved = 0, busy: boolean[] = [], rejectSave!: (error: unknown) => void
const provider: any = { cacheScope: "fixture", capabilities: {},
  getArtworkInventory: async () => { reads++; return inventory },
  saveArtwork: (...args: any[]) => { writes.push(args); return new Promise((_, reject) => { rejectSave = reject }) },
}
useProviderStore.getState().setProvider(provider)
await act(async () => root.render(<PlexArtworkPanel kind="album" itemId="11" role="poster" onBusy={v => busy.push(v)} onSaved={() => saved++} />))
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
const button = (text: string) => { const found = buttons().find(b => b.textContent?.includes(text)); assert.ok(found, text); return found }
assert.equal(reads, 1); assert.equal(writes.length, 0); assert.equal(button("Current Plex image").disabled, true)
await act(async () => button("Alternate Plex image").click())
assert.ok(document.body.textContent?.includes("After saving to Plex")); assert.equal(writes.length, 0)
await act(async () => { const save = button("Save poster to Plex"); save.click(); save.click() })
assert.equal(writes.length, 1); assert.deepEqual(writes[0], ["album", "11", "poster", inventory.baseline, { choice: "alternative" }]); assert.deepEqual(busy, [true])
await act(async () => rejectSave("Plex did not confirm the artwork change"))
assert.equal(saved, 0); assert.equal(button("Save poster to Plex").disabled, true); assert.ok(document.body.textContent?.includes("Reload its current values"))
await act(async () => button("Reload current artwork").click())
assert.equal(reads, 2); assert.equal(writes.length, 1); assert.ok(!document.body.textContent?.includes("After saving to Plex"))
await act(async () => button("Alternate Plex image").click())
await act(async () => useProviderStore.getState().setProvider({ ...provider, cacheScope: "other" }))
await act(async () => button("Save poster to Plex").click())
assert.equal(writes.length, 1, "Retired dialog must never dispatch another write")
await act(async () => root.unmount())
