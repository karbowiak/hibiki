import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test/" })
globalThis.window = dom.window as any
globalThis.document = dom.window.document
globalThis.location = dom.window.location
globalThis.history = dom.window.history
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window)
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window)
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const latest = { id: "latest", title: "New Release", artistName: "Artist", year: 2026, thumbUrl: "image://scoped/latest", releaseDate: "2026-10-12" }
const imported = { ...latest, id: "imported", title: "Old Import", type: "album", year: 2000 }
const tracks = [{ id: "track", title: "Track" }]
const played: string[] = [], contexts: string[] = [], prefetched: string[] = [], albumCalls: string[] = []
let selection: any[] = []
const provider = { cacheScope: "scope-a", async getAlbumTracks(id: string) { albumCalls.push(id); return tracks } }
const library = { latestReleases: [latest], recentlyAdded: [imported], hubs: [] }
mock.module("../../src/stores", () => ({
  useLibraryStore: (selector: any) => selector(library),
  useConnectionStore: (selector: any) => selector({ isConnected: true, isLoading: false }),
  usePlayerStore: (selector: any) => selector({ async playTrack(...args: any[]) { selection = args }, playFromUri() {}, playPlaylist() {} }),
}))
mock.module("../../src/stores/providerStore", () => ({ useProviderStore: Object.assign((selector: any) => selector({ provider }), { getState: () => ({ provider }) }) }))
mock.module("../../src/stores/metadataCache", () => ({ prefetchAlbum: (id: string) => prefetched.push(id), prefetchArtist() {} }))
mock.module("../../src/hooks/useMixThumbnails", () => ({ mixTitleToArtistName: (name: string) => name, mixThumbnailKey: (item: any) => item.id, useMixThumbnails: () => ({}) }))
mock.module("../../src/hooks/useContextMenu", () => ({ useContextMenu: () => ({ handler: (type: string, item: any) => () => contexts.push(`${type}:${item.id}`) }) }))
mock.module("../../src/lib/mediaPlay", () => ({ makeOnPlay: (item: any) => () => played.push(`${item.type}:${item.id}`) }))
mock.module("../../src/components/Pages/Mix", () => ({ selectMix() {}, shuffleTracks: (items: any[]) => items }))
mock.module("../../src/components/ScrollRow", () => ({ ScrollRow: ({ title, titleHref, onPlayAll, children }: any) => <section data-shelf={title}><h2>{titleHref ? <a href={titleHref}>{title}</a> : title}</h2>{onPlayAll && <button onClick={onPlayAll}>Play all {title}</button>}{children}</section> }))
mock.module("../../src/components/MediaCard", () => ({ MediaCard: (props: any) => <button data-card={props.title} data-href={props.href} data-thumb={props.thumb} data-drag={JSON.stringify(props.dragPayload)} onClick={props.onPlay} onContextMenu={props.onContextMenu} onMouseOver={props.prefetch}>{props.title}</button> }))
const { createRoot } = await import("react-dom/client")
const { Home } = await import("../../src/components/Pages/Home")
const root = createRoot(document.getElementById("root")!)
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve() }
await act(async () => { root.render(<Home />); await flush() })
assert.deepEqual(Array.from(document.querySelectorAll("section")).map(element => element.getAttribute("data-shelf")), ["Latest Releases", "Recently Added"])
assert.equal(document.querySelector("[data-shelf='Latest Releases'] h2 a"), null)
const card = document.querySelector("[data-card='New Release']") as HTMLButtonElement
assert.equal(card.dataset.href, "/album/latest")
assert.equal(card.dataset.thumb, latest.thumbUrl)
assert.deepEqual(JSON.parse(card.dataset.drag!), { type: "album", ids: ["latest"], label: "New Release" })
await act(async () => { card.click(); card.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })); card.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })); await flush() })
assert.deepEqual(played, ["album:latest"])
assert.deepEqual(contexts, ["album:latest"])
assert.deepEqual(prefetched, ["latest"])
await act(async () => { (document.querySelector("[data-shelf='Latest Releases'] button") as HTMLButtonElement).click(); await flush() })
assert.deepEqual(albumCalls, ["latest"])
assert.deepEqual(selection.slice(0, 3), [tracks[0], tracks, "Latest Releases"])
await act(async () => root.unmount())
dom.window.close()
