import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test/playlists" })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, history: dom.window.history, location: dom.window.location, IS_REACT_ACT_ENVIRONMENT: true })
const playlist = { id: "one", title: "My playlist", trackCount: 12, thumbUrl: null }
const played: unknown[][] = []
let contextActions = 0
mock.module("../../src/stores/index.ts", () => ({ useLibraryStore: create(() => ({ playlists: [playlist] })) }))
mock.module("../../src/stores/playerStore", () => ({ usePlayerStore: create(() => ({ playPlaylist: async (...args: unknown[]) => { played.push(args) } })) }))
mock.module("../../src/hooks/useContextMenu", () => ({ useContextMenu: () => ({ handler: (kind: string, item: unknown) => (event: Event) => { event.preventDefault(); assert.equal(kind, "playlist"); assert.deepEqual(item, { ...playlist, type: "playlist" }); contextActions++ } }) }))
mock.module("../../src/hooks/useMediaImage", () => ({ useArtistImage: () => null, useAlbumImage: () => null }))
mock.module("../../src/hooks/useTrackDrag", () => ({ useTrackDrag: () => ({}) }))
mock.module("../../src/components/shared/ArtworkImage", () => ({ ArtworkImage: () => null, useArtworkFailures: () => ({ failures: [], onFailure() {} }) }))
const { Playlists } = await import("../../src/components/Pages/Playlists")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
await act(async () => root.render(<Playlists />))
const card = document.querySelector('.group:has(>a[href^="/playlist/"])')!
assert.ok(card)
assert.equal(card.querySelector("a button"), null)
const play = card.querySelector('[aria-label="Play My playlist"]') as HTMLButtonElement
const link = card.querySelector('a[aria-label="My playlist"]') as HTMLAnchorElement
assert.equal(play.type, "button"); assert.equal(play.tabIndex, 0)
assert.equal(link.getAttribute("href"), "/playlist/one")
assert.ok(card.querySelector(".aspect-square"))
await act(async () => play.click())
assert.deepEqual(played, [["one", 12, "My playlist", "/playlist/one"]])
assert.equal(location.pathname, "/playlists")
await act(async () => link.click())
assert.equal(location.pathname, "/playlist/one"); assert.equal(played.length, 1)
await act(async () => link.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })))
assert.equal(contextActions, 1); assert.equal(played.length, 1)
assert.ok(document.body.textContent?.includes("12 songs"))
await act(async () => root.unmount()); dom.window.close()
