import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import { deferred } from "../helpers/radioAudioFakes"
const scenario = process.argv[2]
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://hibiki.test/playlist/same",
})
Object.assign(globalThis, {
  CustomEvent: dom.window.CustomEvent,
  window: dom.window,
  location: dom.window.location,
  history: dom.window.history,
  addEventListener: dom.window.addEventListener.bind(dom.window),
  removeEventListener: dom.window.removeEventListener.bind(dom.window),
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const writes: any[] = [],
  calls: any[] = [],
  loves: any[] = []
const library = create(() => ({
  playlists: [{ id: "same", title: "Original", smart: false }],
  error: null as string | null,
  invalidatePlaylistItems: (id: string) => writes.push(["invalidate", id]),
  renamePlaylist: (id: string, title: string) =>
    writes.push(["rename", id, title]),
  removePlaylist: (id: string) => writes.push(["delete", id]),
  onItemRated: (...args: any[]) => writes.push(["rate", ...args]),
}))
const player = create(() => ({
  playPlaylist() {},
  playTrack() {},
  playFromUri() {},
  playRadio() {},
  addNext: (tracks: any[]) => writes.push(["next", tracks]),
  addToQueue: (tracks: any[]) => writes.push(["queue", tracks]),
}))
mock.module("../../src/stores/index.ts", () => ({
  useLibraryStore: library,
  usePlayerStore: player,
}))
mock.module("../../src/stores/libraryStore.ts", () => ({
  useLibraryStore: library,
}))
mock.module("../../src/stores/playerStore.ts", () => ({
  usePlayerStore: player,
}))
mock.module("../../src/stores/uiStore.ts", () => ({
  useUIStore: create(() => ({
    isArtExpanded: false,
    setShowCreatePlaylist() {},
    setPendingPlaylistItemIds() {},
  })),
}))
mock.module("../../src/stores/debugStore.ts", () => ({
  useDebugStore: create(() => ({ debugEnabled: false })),
}))
mock.module("../../src/stores/debugPanelStore.ts", () => ({
  useDebugPanelStore: create(() => ({ show() {} })),
}))
mock.module("../../src/metadata/deezer/store.ts", () => ({
  useDeezerMetadataStore: create(() => ({ artists: {}, albums: {} })),
}))
mock.module("../../src/metadata/lastfm/authStore.ts", () => ({
  useLastfmStore: create(() => ({ loveThreshold: 8 })),
}))
mock.module("../../src/metadata/lastfm/api.ts", () => ({
  lastfmLoveTrack: async (...args: any[]) => {
    loves.push(args)
  },
}))
mock.module("../../src/components/shared/ArtworkImage.tsx", () => ({
  ArtworkImage: () => null,
  useArtworkFailures: () => ({ failures: [], onFailure() {} }),
}))
mock.module("../../src/hooks/useResizable.ts", () => ({
  useResizable: () => ({ width: 240, onMouseDown() {} }),
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useContextMenuStore: menu } =
  await import("../../src/stores/contextMenuStore")
const first = deferred<any>(),
  second = deferred<any>()
function provider(name: string) {
  return {
    cacheScope: name,
    capabilities: {
      playlists: true,
      ratings: true,
      stations: false,
      radio: false,
    },
    addToPlaylist: async (...args: any[]) => {
      calls.push(["add", name, ...args])
      return calls.filter((x) => x[0] === "add").length === 1
        ? first.promise
        : second.promise
    },
    editPlaylist: async (...args: any[]) => {
      calls.push(["rename", name, ...args])
      return first.promise
    },
    deletePlaylist: async (...args: any[]) => {
      calls.push(["delete", name, ...args])
      return first.promise
    },
    removeFromPlaylist: async (...args: any[]) => {
      calls.push(["remove", name, ...args])
      return first.promise
    },
    getAlbumTracks: async (...args: any[]) => {
      calls.push(["tracks", name, ...args])
      if (scenario === "album")
        return [{ id: "album-track-1" }, { id: "album-track-2" }]
      return first.promise
    },
    rate: async (...args: any[]) => {
      calls.push(["rate", name, ...args])
      return calls.filter((x) => x[0] === "rate").length === 1
        ? first.promise
        : second.promise
    },
  } as any
}
const a = provider("a"),
  b = provider("b")
useProviderStore.getState().setProvider(a)
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text
  )
  assert(button, `missing ${text}`)
  await act(async () => button.click())
}
async function replace() {
  await act(async () => useProviderStore.getState().setProvider(b))
}
async function resolve(value: any = undefined) {
  first.resolve(value)
  await settle()
}
async function unmount() {
  await act(async () => root.unmount())
}

const { SideBar } = await import("../../src/components/SideBar")
const { MediaCard } = await import("../../src/components/MediaCard")
const { useDragStore } = await import("../../src/stores/dragStore")
dom.window.HTMLElement.prototype.setPointerCapture = () => {}
dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
const ids = scenario === "album" ? ["album-id"] : ["1", "1", "2"]
function Source() {
  return (
    <MediaCard
      title="Synthetic source"
      desc="Music"
      thumb={null}
      href="/album/synthetic"
      dragPayload={{
        type: scenario === "album" ? "album" : "track",
        ids,
        label: "Synthetic",
      }}
    />
  )
}
await act(async () =>
  root.render(
    <>
      <Source />
      <SideBar onCreatePlaylist={() => {}} />
    </>
  )
)
const source = document.querySelector("a[aria-label='Synthetic source']")!
const target = document.querySelector("[data-playlist-drop-target='same']")!
assert.ok(target)
;(document as any).elementsFromPoint = (x: number) =>
  x >= 100 ? [target] : [source]
function pointer(type: string, x: number, pointerId = 1) {
  const event = new dom.window.MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX: x,
    clientY: 20,
  })
  Object.defineProperty(event, "pointerId", { value: pointerId })
  return event
}
const results: any[] = []
window.addEventListener("plexify-playlist-drop-result", (event: any) =>
  results.push(event.detail)
)
await act(async () => {
  source.dispatchEvent(pointer("pointerdown", 0))
  source.dispatchEvent(pointer("pointermove", 100))
})
const nativeDrag = new dom.window.Event("dragstart", {
  bubbles: true,
  cancelable: true,
})
source.dispatchEvent(nativeDrag)
assert.equal(
  nativeDrag.defaultPrevented,
  true,
  "native image dragging must not steal the pointer sequence"
)
await act(async () => source.dispatchEvent(pointer("pointerup", 100, 2)))
assert.equal(
  useDragStore.getState().isDragging,
  true,
  "unrelated pointer cannot end a drag"
)
assert.equal(
  useDragStore.getState().hoveredPlaylistId,
  "same",
  "first move must find the target"
)
if (scenario === "retired") await replace()
if (scenario === "scope") a.cacheScope = "replacement-library"
if (scenario === "cancel")
  await act(async () => window.dispatchEvent(pointer("pointercancel", 100)))
await act(async () =>
  source.dispatchEvent(
    pointer("pointerup", scenario === "release-outside" ? 0 : 100)
  )
)
await settle()
if (["retired", "scope", "cancel", "release-outside"].includes(scenario)) {
  assert.deepEqual(calls, [])
  assert.equal(useDragStore.getState().isDragging, false)
} else {
  assert.deepEqual(
    calls,
    scenario === "album"
      ? [
          ["tracks", "a", ids[0]],
          ["add", "a", "same", ["album-track-1"]],
        ]
      : [["add", "a", "same", [ids[0]]]]
  )
  assert.deepEqual(results, [], "drop intent is not a successful mutation")
  if (scenario === "failure") {
    first.reject(Error("private failure"))
    await settle()
    assert.deepEqual(results, [{ targetPlaylistId: "same", success: false }])
    assert.equal(
      library.getState().error,
      "Unable to add items to the playlist. Please try again."
    )
  } else {
    await resolve()
    second.resolve()
    await settle()
    assert.deepEqual(
      calls.filter((x) => x[0] === "add").map((x) => x[3]),
      scenario === "album"
        ? [["album-track-1"], ["album-track-2"]]
        : [["1"], ["1"], ["2"]],
      "duplicate occurrences keep order"
    )
    assert.deepEqual(results, [{ targetPlaylistId: "same", success: true }])
    assert.deepEqual(writes, [["invalidate", "same"]])
  }
}
await unmount()
