import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import { deferred } from "../helpers/radioAudioFakes"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test/podcasts" })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })
const noop = () => {}
mock.module("../../src/stores/index.ts", () => ({ useLibraryStore: create(() => ({ playlists: [] })), usePlayerStore: create(() => ({ playTrack: noop, playFromUri: noop, playRadio: noop, addNext: noop, addToQueue: noop })) }))
mock.module("../../src/stores/uiStore", () => ({ useUIStore: create(() => ({ setShowCreatePlaylist: noop, setPendingPlaylistItemIds: noop })) }))
mock.module("../../src/stores/debugStore", () => ({ useDebugStore: create(() => ({ debugEnabled: false })) }))
mock.module("../../src/stores/debugPanelStore", () => ({ useDebugPanelStore: create(() => ({ show: noop })) }))
mock.module("../../src/metadata/deezer/store", () => ({ useDeezerMetadataStore: create(() => ({ artists: {}, albums: {} })) }))
mock.module("../../src/components/shared/ArtworkImage", () => ({ ArtworkImage: () => null }))
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useContextMenuStore: menu } = await import("../../src/stores/contextMenuStore")
const { AudioBrowseCard } = await import("../../src/components/shared/AudioBrowseCard")
const { ContextMenu } = await import("../../src/components/ContextMenu")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
let opened = 0, favorites = 0, favorite = false
let open: () => void | Promise<void> = () => { opened++ }
function Harness({ present = true, podcast = false }) { return <>{present && <AudioBrowseCard title={podcast ? "Podcast" : "Station"} description="Public audio" src={null} openLabel={podcast ? "Open podcast Podcast" : "Play Station"} intent={podcast ? "open" : "play"} onOpen={() => open()} favorite={favorite} onFavorite={podcast ? undefined : () => { favorites++ }} />}<ContextMenu /></> }
async function render(present = true, podcast = false) { await act(async () => root.render(<Harness present={present} podcast={podcast} />)) }
function primary() { return document.querySelector(".media-card__primary") as HTMLButtonElement }
async function key(value: string, shiftKey = false) { await act(async () => primary().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }))) }
async function click(label: string) { const button = [...document.querySelectorAll('div[role="dialog"] button')].find(button => button.textContent === label) as HTMLButtonElement; assert.ok(button); await act(async () => { button.click(); await Promise.resolve() }) }
await render()
assert.equal(useProviderStore.getState().provider, null)
await act(async () => primary().dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })))
assert.equal(menu.getState().type, "actions"); assert.equal(menu.getState().ownerProvider, null)
assert.equal("id" in menu.getState().data!, false, "public actions must not fabricate Plex identity")
assert.ok(document.querySelector('div[role="dialog"]')!.contains(document.activeElement))
assert.equal(document.body.textContent!.includes("Add to playlist"), false)
await click("Add to favorites"); assert.equal(favorites, 1); assert.equal(opened, 0)
assert.equal(menu.getState().data, null, "closing public menus releases callback references")
favorite = true; await render(); await key("F10", true)
await click("Remove from favorites"); assert.equal(favorites, 2); assert.equal(opened, 0)
await key("ContextMenu"); await click("Play Station"); assert.equal(opened, 1)
await render(true, true); await key("ContextMenu")
assert.equal(document.querySelectorAll('div[role="dialog"] button').length, 1)
await click("Open podcast Podcast"); assert.equal(opened, 2)
// Async callback errors are retained generically and may be retried exactly once.
const pending = deferred<void>(); let attempts = 0
open = () => { attempts++; return attempts === 1 ? pending.promise : Promise.resolve() }
await render(); await key("ContextMenu")
await click("Play Station"); await click("Play Station"); assert.equal(attempts, 1)
await act(async () => { pending.reject(Error("private-source-credentials")); await Promise.resolve(); await Promise.resolve() })
assert.match(document.querySelector('[role="alert"]')!.textContent!, /Could not complete/)
assert.equal(document.body.textContent!.includes("private-source"), false)
await click("Play Station"); assert.equal(attempts, 2); assert.equal(menu.getState().open, false)
// App connection changes fence null-provider menus and suppress late failures.
const late = deferred<void>(); open = () => late.promise
await render(); await key("ContextMenu"); await click("Play Station")
const provider: any = { cacheScope: "current", capabilities: { playlists: false, radio: false, ratings: false } }
await act(async () => useProviderStore.getState().setProvider(provider)); assert.equal(menu.getState().open, false)
await act(async () => { late.reject(Error("late-private-error")); await Promise.resolve(); await Promise.resolve() })
assert.equal(document.querySelector('[role="alert"]'), null)
// Public actions also work with a provider lacking all relevant capabilities.
open = () => { opened++ }; await render(); await key("ContextMenu"); await click("Play Station"); assert.equal(opened, 3)
await key("ContextMenu"); provider.cacheScope = "replacement"
await click("Play Station"); assert.equal(opened, 3)
await act(async () => useProviderStore.getState().setProvider(provider)); assert.equal(menu.getState().open, false)
await key("ContextMenu"); await render(false); assert.equal(menu.getState().open, false); assert.equal(menu.getState().data, null)
await act(async () => root.unmount()); dom.window.close()
