import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { create } from "zustand"
import { settle, deferred } from "../helpers/radioAudioFakes"
const dom = new JSDOM('<div id="root"></div>', { url: "https://hibiki.test/" })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const sections = [
  { key: 5, uuid: "current", title: "Music", section_type: "artist" },
  { key: 8, uuid: "classical", title: "Classical", section_type: "artist" },
]
const connections: any[] = [],
  rpc: any[] = []
const connection = create(() => ({
  musicSectionTitle: "Music",
  musicSectionId: 5,
  sectionUuid: "current",
  availableMusicSections: sections,
  isLoading: false,
  isOffline: false,
  connect: async (...args: any[]) => {
    connections.push(args)
  },
  switchLibrary: async () => {
    throw Error("Unexpected fallback switch")
  },
}))
mock.module("../../src/backends/plex/connectionStore.ts", () => ({
  useConnectionStore: connection,
}))
const stale = deferred<any>()
let hold = false
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: any) => {
    rpc.push({ command, args })
    if (hold) return stale.promise
    if (command === "library_picker_servers")
      return {
        servers: [
          { id: "here", name: "Home server", current: true },
          { id: "there", name: "Shared server", current: false },
        ],
        notice: null,
      }
    if (command === "library_picker_sections")
      return args.serverId === "here"
        ? sections
        : [{ key: 42, uuid: "remote-library", title: "Jazz" }]
    if (command === "library_picker_resolve")
      return {
        baseUrl: "https://shared.test",
        token: "fixture-resource-token",
        allUrls: ["https://shared.test"],
        machineIdentifier: "shared-server",
        sectionId: 42,
        sectionUuid: "remote-library",
      }
    throw Error(command)
  },
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useCatalogueStore } = await import("../../src/offline/catalogueStore")
const { MusicLibraryPicker } =
  await import("../../src/components/MusicLibraryPicker")
useProviderStore
  .getState()
  .setProvider({ cacheScope: "scope", playbackSession: {} } as any)
useCatalogueStore
  .getState()
  .activate({ connectionRevision: 7, cacheScope: "scope" })
const root = createRoot(document.getElementById("root")!)
await act(async () => {
  root.render(<MusicLibraryPicker />)
  await settle()
})
const trigger = document.querySelector(
  'button[aria-haspopup="menu"]'
) as HTMLButtonElement
await act(async () => {
  trigger.click()
  await settle()
})
const menu = document.querySelector('[role="menu"]')!
assert(
  menu && !document.getElementById("root")!.contains(menu),
  "menu portal escapes page/card stacking contexts"
)
assert(menu.querySelector('[role="group"][aria-label="Shared server"]'))
const options = [
  ...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
]
assert.deepEqual(
  options.map((b) => b.textContent),
  ["Music", "Classical", "Jazz"]
)
assert.equal(document.activeElement, options[0])
await act(async () => {
  options[0].dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true })
  )
})
assert.equal(document.activeElement, options[2])
assert.equal(
  connections.length,
  0,
  "browsing and keyboard focus do not switch server/playback"
)
await act(async () => {
  options[2].click()
  await settle()
})
assert.deepEqual(connections, [
  [
    "https://shared.test",
    "fixture-resource-token",
    ["https://shared.test"],
    42,
    undefined,
    "shared-server",
    "remote-library",
  ],
])
assert.equal(document.querySelector('[role="menu"]'), null)
await act(async () => {
  trigger.click()
  await settle()
})
await act(async () => {
  document.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  )
})
assert.equal(document.querySelector('[role="menu"]'), null)
assert.equal(document.activeElement, trigger)
await act(async () => {
  trigger.click()
  await settle()
})
hold = true
await act(async () => {
  ;(
    document.querySelector(
      'button[aria-label="Refresh music libraries"]'
    ) as HTMLButtonElement
  ).click()
  await settle()
})
await act(async () => {
  useProviderStore
    .getState()
    .setProvider({ cacheScope: "other", playbackSession: {} } as any)
  useCatalogueStore
    .getState()
    .activate({ connectionRevision: 8, cacheScope: "other" })
  await settle()
})
await act(async () => {
  stale.resolve({
    servers: [{ id: "old-private", name: "Retired account", current: true }],
    notice: null,
  })
  await settle()
})
assert(!document.body.textContent!.includes("Retired account"))
assert.equal(connections.length, 1)
await act(async () => {
  root.unmount()
})
dom.window.close()
