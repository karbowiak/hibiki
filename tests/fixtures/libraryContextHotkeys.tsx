import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
const dom = new JSDOM("<div id='root'></div><textarea id='editor'></textarea>", { url: "https://hibiki.test/library" })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, addEventListener: dom.window.addEventListener.bind(dom.window), removeEventListener: dom.window.removeEventListener.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })
const noop = () => {}
const actions: any[] = []
const common: any = { title: "Album", id: "album", artistName: "Artist", albumName: "Album", artistId: "artist", albumId: "album", trackCount: 1, userRating: 5, thumbUrl: null, duration: 1000, providerKey: "/library/metadata/album" }
const album = { ...common }, track = { ...common, id: "track", title: "Track" }, artist = { ...common, id: "artist", title: "Artist" }, playlist = { ...common, id: "playlist", title: "Playlist", providerKey: "/playlists/playlist", smart: false }
const library = create<any>(() => ({ playlists: [playlist], likedAlbums: [album], likedArtists: [artist], likedTracks: [track], hubs: [], wsConnected: false, fetchLikedAlbums: async () => {}, fetchLikedArtists: async () => {}, fetchLikedTracks: async () => {}, refreshAll: async () => {}, invalidateCache: noop, onItemRated: noop, invalidatePlaylistItems: noop }))
const player = create<any>(() => ({ playTrack: (item: any) => actions.push(["play", item.id]), playFromUri: (...args: any[]) => actions.push(["uri", ...args]), playRadio: (...args: any[]) => actions.push(["radio", ...args]), addNext: noop, addToQueue: noop, pause: () => actions.push(["pause"]), currentTrack: track, isPlaying: true, prefetchTrackAudio: noop }))
const search = create<any>(set => ({ query: "existing query", results: [], error: null, isSearching: false, setQuery: (query: string) => set({ query }), search: async () => {}, clear: noop }))
const ui = create<any>(() => ({ pageRefreshKey: 0, isRefreshing: false, setIsRefreshing: noop, incrementPageRefreshKey: noop, setShowCreatePlaylist: noop, setPendingPlaylistItemIds: noop }))
mock.module("../../src/stores/index.ts", () => ({ useLibraryStore: library, usePlayerStore: player, useSearchStore: search, useUIStore: ui, useConnectionStore: create(() => ({ musicSectionId: 1, isConnected: true })) }))
mock.module("../../src/stores/playerStore", () => ({ usePlayerStore: player, prefetchTrackAudio: noop }))
mock.module("../../src/stores/libraryStore", () => ({ useLibraryStore: library }))
mock.module("../../src/stores/uiStore", () => ({ useUIStore: ui }))
mock.module("../../src/stores/visualizerStore", () => ({ useVisualizerStore: create(() => ({ fullscreenOpen: false, closeFullscreen: noop })) }))
mock.module("../../src/stores/radioStreamStore", () => ({ useRadioStreamStore: create(() => ({})) }))
mock.module("../../src/stores/artworkAppearanceStore", () => ({ useArtworkAppearanceStore: create(() => ({ backgroundArtworkEnabled: false })) }))
mock.module("../../src/stores/debugStore", () => ({ useDebugStore: create(() => ({ debugEnabled: false })) }))
mock.module("../../src/stores/debugPanelStore", () => ({ useDebugPanelStore: create(() => ({ show: noop })) }))
mock.module("../../src/metadata/deezer/store", () => ({ useDeezerMetadataStore: create(() => ({ artists: {}, albums: {} })) }))
mock.module("../../src/metadata", () => ({ metadataBackends: [] }))
mock.module("../../src/hooks/useMediaImage", () => ({ useArtistImage: () => null, useAlbumImage: () => null }))
mock.module("../../src/components/shared/ArtworkImage", () => ({ ArtworkImage: () => null, useArtworkFailures: () => ({ failures: [], onFailure: noop }) }))
mock.module("../../src/components/ScrollRow", () => ({ ScrollRow: ({ title, children }: any) => <section><h2>{title}</h2>{children}</section> }))
mock.module("../../src/components/ActivityIndicator", () => ({ ActivityIndicator: () => null }))
mock.module("../../src/components/NotificationCenter", () => ({ NotificationCenter: () => null }))
mock.module("../../src/components/AmbientArtworkControls", () => ({ AmbientArtworkControls: () => null }))
mock.module("../../src/components/SearchDropdown", () => ({ SearchDropdown: () => <div>Search choices</div>, buildSearchItems: () => [], buildSearchLandingItems: () => [] }))
mock.module("../../src/components/shared/StarRating", () => ({ StarRating: () => null }))
mock.module("../../src/hooks/useColumnPicker", () => ({ ColumnPicker: () => null }))
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useContextMenuStore: menu } = await import("../../src/stores/contextMenuStore")
const provider: any = { cacheScope: "library-one", capabilities: { playlists: false, ratings: false, radio: false, stations: false }, buildItemUri: (key: string) => key, buildPlaylistUri: (key: string) => key, getAlbumTracks: async () => [] }
useProviderStore.getState().setProvider(provider)
const { useGlobalHotkeys } = await import("../../src/hooks/useGlobalHotkeys")
const { TopBar } = await import("../../src/components/TopBar")
const { Library } = await import("../../src/components/Pages/Library")
const { ContextMenu } = await import("../../src/components/ContextMenu")
const { TrackTable } = await import("../../src/components/shared/TrackTable")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
function Harness({ table = false }) { useGlobalHotkeys(); return <><TopBar />{table ? <TrackTable tracks={[]} visibleCols={new Set()} toggleCol={noop} sortCol="default" sortDir="asc" onSort={noop} onPlay={noop} onAddToQueue={noop} onPlayRadio={noop} columns={[]} searchPlaceholder="Page filter" filterQuery="" onFilterChange={noop} /> : <Library />}<ContextMenu /></> }
async function render(table = false) { await act(async () => root.render(<Harness table={table} />)) }
async function key(target: HTMLElement, value: string, init: KeyboardEventInit = {}) { const e = new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init }); await act(async () => target.dispatchEvent(e)); return e }
const field = () => document.querySelector('[data-library-search="true"]') as HTMLInputElement
await render()
for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
  const e = await key(document.body, "k", modifier); assert.equal(e.defaultPrevented, true); assert.equal(document.activeElement, field()); assert.equal(field().selectionStart, 0); assert.equal(field().selectionEnd, "existing query".length)
}
// A delayed blur belongs to the focus it left, never a later CmdK refocus.
await act(async () => { field().focus(); (document.getElementById("editor") as HTMLElement).focus() })
await key(document.body, "k", { ctrlKey: true })
await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
assert.equal(field().getAttribute("aria-expanded"), "true", "old blur must not hide a reopened search")
for (const [name, type] of [["Playlist", "playlist"], ["Track", "track"], ["Album", "album"], ["Artist", "artist"]]) {
  const card = document.querySelector(`.media-card__primary[aria-label="${name}"]`) as HTMLElement
  assert.ok(card)
  await act(async () => card.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })))
  assert.equal(menu.getState().type, type); assert.equal(menu.getState().ownerScope, "library-one")
  assert.equal(document.querySelector('div[role="dialog"]')!.getAttribute("aria-label"), `${name} actions`)
  assert.ok(document.querySelector('div[role="dialog"]')!.contains(document.activeElement))
  assert.equal(document.body.textContent!.includes("Add to playlist"), false)
  assert.equal(document.body.textContent!.includes("Start radio"), false)
  await key(document.activeElement as HTMLElement, "Escape"); assert.equal(menu.getState().open, false); assert.equal(document.activeElement, card)
}
provider.capabilities = { ...provider.capabilities, playlists: true, playlistEdit: true, radio: true }
await act(async () => useProviderStore.getState().setProvider(provider))
const playlistCard = document.querySelector('.media-card__primary[aria-label="Playlist"]') as HTMLElement
await key(playlistCard, "ContextMenu")
assert.ok([...document.querySelectorAll("button")].some(button => button.textContent === "Delete"))
const radio = [...document.querySelectorAll("button")].find(button => button.textContent === "Start radio")!
await act(async () => radio.click())
assert.deepEqual(actions, [["radio", "playlist", "playlist"]]); actions.length = 0
const trackCard = document.querySelector('.media-card__primary[aria-label="Track"]') as HTMLElement
await key(trackCard, "ContextMenu")
assert.ok(document.body.textContent!.includes("Add to playlist"))
await key(document.activeElement as HTMLElement, "Escape")
const albumCard = document.querySelector('.media-card__primary[aria-label="Album"]') as HTMLElement
await key(albumCard, "F10", { shiftKey: true }); assert.equal(menu.getState().type, "album")
const first = document.activeElement as HTMLElement
await key(first, "ArrowDown"); assert.notEqual(document.activeElement, first)
await key(document.activeElement as HTMLElement, "Home"); assert.equal(document.activeElement, first)
await key(first, "k", { ctrlKey: true }); assert.equal(menu.getState().open, false); assert.equal(document.activeElement, field(), "menu cleanup must not steal search focus")
await key(albumCard, "ContextMenu"); assert.equal(menu.getState().open, true)
provider.cacheScope = "library-two"
const playAlbum = [...document.querySelectorAll("button")].find(button => button.textContent === "Play album")!
await act(async () => playAlbum.click()); assert.deepEqual(actions, [], "retired same-instance library menu must not play")
await act(async () => useProviderStore.getState().setProvider(provider)); assert.equal(menu.getState().open, false)
assert.notEqual(document.activeElement, albumCard, "library changes must not refocus retired cards or prefetch their metadata")
await render(true)
await act(async () => history.replaceState(null, "", "/album/album"))
await key(document.body, "K", { ctrlKey: true }); assert.equal(document.activeElement, field(), "page filter must not intercept global search")
await key(document.body, "k", { ctrlKey: true, repeat: true }); assert.equal(document.activeElement, field())
const editor = document.getElementById("editor") as HTMLTextAreaElement
for (const init of [{ ctrlKey: true, altKey: true }, { metaKey: true, shiftKey: true }, { ctrlKey: true, isComposing: true }]) { await act(async () => editor.focus()); await key(editor, "k", init); assert.equal(document.activeElement, editor) }
const block = (e: KeyboardEvent) => { e.preventDefault(); e.stopImmediatePropagation() }
window.addEventListener("keydown", block, true); await act(async () => editor.focus()); await key(editor, "k", { ctrlKey: true }); assert.equal(document.activeElement, editor); window.removeEventListener("keydown", block, true)
await act(async () => root.unmount()); dom.window.close()
