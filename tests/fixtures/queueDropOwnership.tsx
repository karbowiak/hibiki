import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import { deferred } from "../helpers/radioAudioFakes"
const scenario = process.argv[2]
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
globalThis.window = dom.window as any
globalThis.document = dom.window.document
Object.assign(globalThis, { location: dom.window.location, history: dom.window.history })
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(0), 0) as any
globalThis.cancelAnimationFrame = handle => clearTimeout(handle)
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let version = 0
const track = (id: string) => ({ id, title: id, artistName: "Artist", thumbUrl: null, duration: 1000 })
const added: string[][] = [], announcements: string[] = []
const player = create<any>(set => ({
  queue: [track("original")], queueIndex: 0, repeat: 0, shuffle: false, playerError: null,
  reorderQueue() {}, removeFromQueue() {}, jumpToQueueItem() {}, clearUpcoming() {},
  addToQueue(tracks: any[]) { added.push(tracks.map(track => track.id)); set((state: any) => ({ queue: [...state.queue, ...tracks] })) },
}))
mock.module("../../src/stores/index.ts", () => ({ usePlayerStore: player }))
mock.module("../../src/stores/playerStore", () => ({ usePlayerStore: player, ensureQueueRange: async () => {}, capturePlaybackSelectionVersion: () => version, isDjGenerated: () => false, isRadioGenerated: () => false }))
const ui = create(() => ({ isQueueOpen: true, isQueuePinned: false, queueActiveTab: "queue", setQueueOpen() {}, setQueuePinned() {}, setQueueActiveTab() {} }))
mock.module("../../src/stores/uiStore", () => ({ useUIStore: ui }))
mock.module("../../src/stores/dragStore", () => ({ useDragStore: create(() => ({ isDragging: false, hoveredQueue: false })) }))
mock.module("../../src/stores/announcerStore", () => ({ useAnnouncerStore: { getState: () => ({ announce: (message: string) => announcements.push(message) }) } }))
mock.module("../../src/hooks/useResizable", () => ({ useResizable: () => ({ width: 320, onMouseDown() {}, isDragging: false }) }))
mock.module("../../src/components/LyricsPanel", () => ({ LyricsContent: () => null }))
mock.module("@dnd-kit/core", () => ({ DndContext: ({ children }: any) => children, closestCenter() {}, PointerSensor() {}, useSensor() {}, useSensors() {} }))
mock.module("@dnd-kit/sortable", () => ({ SortableContext: ({ children }: any) => children, verticalListSortingStrategy() {}, useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef() {}, transform: null, transition: null, isDragging: false }) }))
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const { useProviderStore } = await import("../../src/stores/providerStore")
const { QueuePanel } = await import("../../src/components/QueuePanel")
const album = deferred<any[]>(), artist = deferred<any[]>()
let albumCalls = 0, artistCalls = 0
const provider: any = { cacheScope: "original", getAlbumTracks() { albumCalls++; return album.promise }, getArtistPopularTracks() { artistCalls++; return artist.promise } }
useProviderStore.getState().setProvider(provider)
async function flush() { for (let turn = 0; turn < 20; turn++) await Promise.resolve() }
await act(async () => { root.render(<QueuePanel />); await flush() })
async function drop(type: string, tracks?: any[]) {
  await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("plexify-media-drop", { detail: { targetQueue: true, payload: { type, ids: ["one"], tracks, label: "one" } } })); await flush() })
}
async function settle(pending: ReturnType<typeof deferred<any[]>>, tracks: any[], fail = false) {
  await act(async () => { if (fail) pending.reject(new Error("private-token-in-provider-error")); else pending.resolve(tracks); await flush() })
}
await drop("album")
assert.equal(albumCalls, 1)
if (scenario === "provider") {
  await act(async () => useProviderStore.getState().setProvider({ ...provider, cacheScope: "replacement" }))
  await settle(album, [track("old")])
  assert.deepEqual(added, [])
} else if (scenario === "scope") {
  provider.cacheScope = "replacement"
  await settle(album, [track("old")])
  assert.deepEqual(added, [])
} else if (scenario === "selection") {
  version++
  await act(async () => player.setState({ queue: [track("replacement")] }))
  await settle(album, [track("old")], true)
  assert.deepEqual(added, [])
  assert.deepEqual(announcements, [])
  assert.equal(player.getState().playerError, null)
} else if (scenario === "unmount") {
  await act(async () => root.unmount())
  await settle(album, [track("old")])
  assert.deepEqual(added, [])
} else if (scenario === "ordered") {
  await drop("artist")
  await drop("track", [track("direct")])
  assert.equal(artistCalls, 1, "metadata lookup should start concurrently")
  await settle(artist, [track("artist")])
  assert.deepEqual(added, [], "later additions must wait for earlier intent")
  await settle(album, [track("album-a"), track("album-b")])
  assert.deepEqual(added, [["album-a", "album-b"], ["artist"], ["direct"]])
} else if (scenario === "failure") {
  await drop("artist")
  await settle(artist, [track("wanted")])
  await settle(album, [], true)
  assert.deepEqual(added, [["wanted"]], "one failure must not discard later additions")
  assert.equal(announcements.length, 1)
  assert.equal(player.getState().playerError, "Could not add tracks to the queue. Try again.")
  assert(!announcements[0].includes("private-token"))
} else if (scenario === "replacement-unblocked") {
  version++
  await act(async () => player.setState({ queue: [track("replacement")] }))
  await drop("track", [track("new")])
  assert.deepEqual(added, [["new"]], "a retired unresolved request must not block the new queue")
  await settle(album, [], true)
  assert.deepEqual(added, [["new"]])
  assert.equal(player.getState().playerError, null)
}
if (scenario !== "unmount") await act(async () => root.unmount())
