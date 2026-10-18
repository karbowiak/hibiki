import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { MusicSourceBadge } from "../../src/components/shared/MusicSource"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test/playlists", pretendToBeVisual: true })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} disconnect() {} },
})
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const playlists = [{ id: "42", title: "Same name" }, { id: "ytmusic:VLlist", title: "Same name", youtubeMusic: { id: "VLlist" } }]
const calls: unknown[][] = []
mock.module("../../src/hooks/useLibraryPlaylists", () => ({ useLibraryPlaylists: (options: any) => {
  assert.equal(options.collapseLinked, false)
  return { playlists, youtube: { connected: true, more: false, loading: false, error: false } }
} }))
mock.module("../../src/stores/mixedPlaylistStore", () => ({ useMixedPlaylistStore: { getState: () => ({ queueMerge: async (...args: unknown[]) => {
  calls.push(args); return { id: args[4] }
} }) } }))
mock.module("../../src/components/shared/LibraryPlaylistCard", () => ({ PlaylistSourceBadge: ({ playlist }: any) => <MusicSourceBadge source={playlist.youtubeMusic ? "ytmusic" : "plex"} /> }))
const { MergePlaylistsDialog } = await import("../../src/components/PlaylistSync/MergePlaylistsDialog")
const root = createRoot(document.getElementById("root")!)
let closed = 0
await act(async () => root.render(<MergePlaylistsDialog onClose={() => { closed++ }} />))
const first = document.querySelector('select[aria-label="First playlist"]') as HTMLSelectElement
const second = document.querySelector('select[aria-label="Second playlist"]') as HTMLSelectElement
assert.equal(first.options.length, 3)
assert.equal(second.options.length, 3)
await act(async () => (document.querySelector('button[aria-label="First playlist"]') as HTMLButtonElement).click())
assert.equal(document.querySelectorAll('[role="option"] [data-music-source]').length, 2)
await act(async () => { first.value = "42"; first.dispatchEvent(new dom.window.Event("change", { bubbles: true })) })
assert.deepEqual([...second.options].map(option => option.value), ["", "ytmusic:VLlist"])
await act(async () => { second.value = "ytmusic:VLlist"; second.dispatchEvent(new dom.window.Event("change", { bubbles: true })) })
assert.deepEqual([...first.options].map(option => option.value), ["", "42"])
assert.equal(document.querySelector('button[aria-label="First playlist"] [data-music-source]')?.getAttribute("data-music-source"), "plex")
assert.equal(document.querySelector('button[aria-label="Second playlist"] [data-music-source]')?.getAttribute("data-music-source"), "ytmusic")
assert.ok(!document.body.textContent!.includes("Review merge"))
const create = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Create merged playlist")!
assert.equal(create.disabled, false)
await act(async () => create.click())
assert.equal(calls.length, 1)
assert.equal(calls[0][2], "verified")
assert.deepEqual(calls[0][0], [{ key: "42", title: "Same name" }, { key: "ytmusic:VLlist", title: "Same name" }])
assert.equal((calls[0][3] as any).title, "Same name")
assert.equal(closed, 1)
await act(async () => root.unmount())
dom.window.close()
