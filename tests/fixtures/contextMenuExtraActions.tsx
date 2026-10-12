import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import { deferred } from "../helpers/radioAudioFakes"
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://hibiki.test/podcasts",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const noop = () => {}
mock.module("../../src/stores/index.ts", () => ({
  useLibraryStore: create(() => ({ playlists: [] })),
  usePlayerStore: create(() => ({
    playTrack: noop,
    playFromUri: noop,
    playRadio: noop,
    addNext: noop,
    addToQueue: noop,
  })),
}))
mock.module("../../src/stores/uiStore", () => ({
  useUIStore: create(() => ({
    setShowCreatePlaylist: noop,
    setPendingPlaylistItemIds: noop,
  })),
}))
mock.module("../../src/stores/debugStore", () => ({
  useDebugStore: create(() => ({ debugEnabled: false })),
}))
mock.module("../../src/stores/debugPanelStore", () => ({
  useDebugPanelStore: create(() => ({ show: noop })),
}))
mock.module("../../src/metadata/deezer/store", () => ({
  useDeezerMetadataStore: create(() => ({ artists: {}, albums: {} })),
}))
mock.module("../../src/components/shared/ArtworkImage", () => ({
  ArtworkImage: () => null,
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useContextMenuStore: menu } =
  await import("../../src/stores/contextMenuStore")
const { ContextMenu } = await import("../../src/components/ContextMenu")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)

const provider: any = {
  cacheScope: "current",
  capabilities: {
    playlists: true,
    playlistEdit: true,
    radio: false,
    ratings: false,
  },
}
await act(async () => useProviderStore.getState().setProvider(provider))
await act(async () => root.render(<ContextMenu />))
const playlist: any = {
  type: "playlist",
  id: "42",
  title: "Ordered playlist",
  smart: false,
  trackCount: 3,
}
let calls = 0
async function show(actions: any[] = []) {
  await act(async () =>
    menu.getState().show(20, 20, "playlist", playlist, null, actions)
  )
}
function button(label: string) {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      'div[role="dialog"] button'
    ),
  ].find((item) => item.textContent === label)
  assert.ok(found, label)
  return found!
}
async function click(label: string) {
  await act(async () => button(label).click())
}
await show([
  {
    label: "Export a private copy",
    run: () => {
      calls++
    },
  },
])
assert.ok(button("Rename"))
assert.ok(button("Delete"))
assert.ok(button("Export a private copy"))
await click("Export a private copy")
assert.equal(calls, 1)
assert.deepEqual(menu.getState().extraActions, [])
const pending = deferred<void>()
await show([
  {
    label: "Export a private copy",
    run: () => {
      calls++
      return pending.promise
    },
  },
])
await click("Export a private copy")
await click("Export a private copy")
assert.equal(calls, 2)
await show()
assert.deepEqual(menu.getState().extraActions, [])
await act(async () => {
  pending.reject(Error("private-stale-error"))
  await Promise.resolve()
})
assert.equal(document.querySelector('[role="alert"]'), null)
await show([
  {
    label: "Export a private copy",
    run: () => {
      calls++
    },
  },
])
provider.cacheScope = "retired"
await click("Export a private copy")
assert.equal(calls, 2)
await act(async () => menu.getState().close())
assert.deepEqual(menu.getState().extraActions, [])
await show([
  {
    label: "Export a private copy",
    run: () => {
      calls++
    },
  },
])
await act(async () =>
  menu
    .getState()
    .showActions(20, 20, { title: "Public station", owner: {}, actions: [] })
)
assert.deepEqual(menu.getState().extraActions, [])
await act(async () => root.unmount())
dom.window.close()
