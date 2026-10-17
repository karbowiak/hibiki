import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { Router } from "wouter"
import { memoryLocation } from "wouter/memory-location"
import type { MusicEntityRef } from "../../src/lib/musicEntity"
import { musicEntityHref } from "../../src/lib/musicEntity"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test/" })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location,
  IS_REACT_ACT_ENVIRONMENT: true })
const requests: ((href: string | null) => void)[] = []
let navigation = 0, owner = true, drags = 0
mock.module("../../src/lib/musicLinks", () => ({
  musicEntityHref,
  resolveMusicEntity: () => new Promise<string | null>(done => requests.push(done)),
  captureMusicLinkOwner: () => () => owner,
  beginMusicLinkNavigation: () => ++navigation,
  isMusicLinkNavigation: (request: number) => request === navigation,
}))
const { MusicEntityLink } = await import("../../src/components/shared/MusicEntityLink")
const history = memoryLocation({ path: "/", record: true })
const root = createRoot(document.getElementById("root")!)
async function render(entity: MusicEntityRef) {
  await act(async () => root.render(<Router hook={history.hook}>
    <div onPointerDown={() => drags++}><MusicEntityLink entity={entity}>Playing song</MusicEntityLink></div>
  </Router>))
}
async function click() {
  const link = document.querySelector("a,button")!
  await act(async () => {
    link.dispatchEvent(new dom.window.MouseEvent("pointerdown", { button: 0, bubbles: true }))
    link.dispatchEvent(new dom.window.MouseEvent("click", { button: 0, bubbles: true, cancelable: true }))
  })
}
await render({ kind: "album", name: "Known", id: "known" })
await click()
assert.equal(history.history!.at(-1), "/album/known")
assert.equal(drags, 0, "ordinary album links must not activate the playbar drag source")
await act(async () => history.navigate("/"))
await render({ kind: "album", name: "Old", id: "ytmusic:MPRE_old", trackId: "ytmusic:abcdefghijk" })
await click()
await render({ kind: "album", name: "New", id: "ytmusic:MPRE_new", trackId: "ytmusic:lmnopqrstuv" })
assert.equal(document.querySelector("a")!.getAttribute("aria-busy"), "false")
await act(async () => requests.shift()!("/album/old"))
assert.equal(history.history!.at(-1), "/", "a song change must retire the old album lookup")
await click()
await act(async () => requests.shift()!("/album/new"))
assert.equal(history.history!.at(-1), "/album/new")
await act(async () => history.navigate("/"))
await render({ kind: "album", name: "Missing", trackId: "song" })
await click()
owner = false
await act(async () => requests.shift()!("/album/wrong-account"))
assert.equal(history.history!.at(-1), "/", "connection changes must retire navigation")
await act(async () => root.unmount())
dom.window.close()
