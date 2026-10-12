import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location, history: dom.window.history, IS_REACT_ACT_ENVIRONMENT: true })
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(0), 0) as any
globalThis.cancelAnimationFrame = handle => clearTimeout(handle)
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.HTMLElement.prototype.setPointerCapture = () => {}
dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
const noop = () => {}
let plays = 0, removes = 0, jumps = 0, navigationIntents = 0, seeks = 0
const track: any = { id: "one", title: "First track", artistName: "Artist", duration: 1000, thumbUrl: null }
const next = { ...track, id: "two", title: "Next track" }
const player = create<any>(() => ({ currentTrack: track, queue: [track, next], queueIndex: 0, lyricsLines: [], positionMs: 0, repeat: 0, shuffle: false, reorderQueue: noop, removeFromQueue() { removes++ }, jumpToQueueItem() { jumps++ }, clearUpcoming: noop, addToQueue: noop, seekTo() { seeks++ } }))
mock.module("../../src/stores/index.ts", () => ({ usePlayerStore: player, useLibraryStore: create(() => ({})), useConnectionStore: create(() => ({})) }))
mock.module("../../src/stores/playerStore", () => ({ usePlayerStore: player, prefetchTrackAudio: noop, capturePlaybackSelectionVersion: () => 0, isDjGenerated: () => false, isRadioGenerated: () => false }))
const ui = create<any>(set => ({ isQueueOpen: true, isQueuePinned: false, isLyricsOpen: true, isLyricsPinned: false, queueActiveTab: "queue", setQueueOpen: (open: boolean) => set({ isQueueOpen: open }), setLyricsOpen: (open: boolean) => set({ isLyricsOpen: open }), setQueuePinned: noop, setLyricsPinned: noop, setQueueActiveTab: noop }))
mock.module("../../src/stores/uiStore", () => ({ useUIStore: ui }))
mock.module("../../src/hooks/useResizable", () => ({ useResizable: () => ({ width: 320, onMouseDown: noop, isDragging: false }) }))
mock.module("../../src/hooks/useCapability", () => ({ useCapability: () => true }))
mock.module("../../src/hooks/useContextMenu", () => ({ useContextMenu: () => ({ handler: () => noop, isTarget: () => false }) }))
mock.module("../../src/hooks/useMediaImage", () => ({ useArtistImage: () => null, useAlbumImage: () => null }))
mock.module("../../src/components/shared/ArtworkImage", () => ({ ArtworkImage: () => null, useArtworkFailures: () => ({ failures: [], onFailure: noop }) }))
mock.module("../../src/hooks/useColumnPicker", () => ({ ColumnPicker: () => null }))
mock.module("../../src/components/shared/StarRating", () => ({ StarRating: () => null }))
const lyrics = create<any>(() => ({ sources: [], activeSourceId: null, geniusHits: [], isSearching: false, isFetchingLyrics: false, selectSource: noop, fetchGeniusLyrics: async () => {} }))
mock.module("../../src/stores/lyricsStore", () => ({ useLyricsStore: lyrics }))
mock.module("../../src/stores/lyricsOffsetStore", () => ({ useLyricsOffsetStore: create(() => ({ offsetMs: 0, setOffset: noop, resetOffset: noop })) }))
mock.module("@dnd-kit/core", () => ({ DndContext: ({ children }: any) => children, closestCenter: noop, PointerSensor: noop, useSensor: noop, useSensors: noop }))
mock.module("@dnd-kit/sortable", () => ({ SortableContext: ({ children }: any) => children, verticalListSortingStrategy: noop, useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: noop, transform: null, transition: null, isDragging: false }) }))
const { createRoot } = await import("react-dom/client")
const { MediaCard } = await import("../../src/components/MediaCard")
const { TrackTable } = await import("../../src/components/shared/TrackTable")
const { QueuePanel } = await import("../../src/components/QueuePanel")
const { default: LyricsPanel, LyricsContent } = await import("../../src/components/LyricsPanel")
const root = createRoot(document.getElementById("root")!)
async function render(element: any) { await act(async () => root.render(element)) }
function named(name: string) { const button = document.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement; assert.ok(button); return button }
async function click(element: HTMLElement) { await act(async () => element.click()) }
await render(<MediaCard title="Mix" desc="Station" thumb={null} href="/mix/one" onClick={() => { navigationIntents++ }} onPlay={() => { plays++ }} />)
assert.equal(document.querySelector("a button"), null)
await click(named("Play Mix")); assert.equal(plays, 1); assert.equal(navigationIntents, 0)
await click(named("Mix")); assert.equal(navigationIntents, 1); assert.equal(plays, 1)
await render(<MediaCard title="Quick mix" desc="Station" thumb={null} onClick={() => { plays++ }} onPlay={() => { plays++ }} dragPayload={{ type: "album", ids: ["one"], label: "One" }} />)
assert.equal(named("Quick mix").tagName, "BUTTON"); assert.equal(named("Quick mix").tabIndex, 0)
await click(named("Play Quick mix")); assert.equal(plays, 2)
await click(named("Quick mix")); assert.equal(plays, 3)
function pointer(type: string, x: number) { const e = new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 0 }); Object.defineProperty(e, "pointerId", { value: 1 }); return e }
await act(async () => { const primary = named("Quick mix"); primary.dispatchEvent(pointer("pointerdown", 0)); primary.dispatchEvent(pointer("pointermove", 20)); primary.dispatchEvent(pointer("pointerup", 20)); primary.click() })
assert.equal(plays, 3, "drag release must not play")
mock.module("../../src/components/Pages/Mix", () => ({ selectMix: noop, shuffleTracks: (tracks: any[]) => tracks }))
const { RecentMixCard } = await import("../../src/components/Pages/Stations")
await render(<RecentMixCard mix={{ seeds: [{ id: "seed", title: "Seed", thumb: null }], tabType: "artist", createdAt: Date.now() } as any} sectionUuid="fixture" sectionId={1} playFromUri={async () => { plays++ }} />)
assert.equal(named("Play Seed mix").tagName, "BUTTON")
const beforeMix = plays; await click(named("Play Seed mix")); assert.equal(plays, beforeMix + 1)
const props: any = { tracks: [track], visibleCols: new Set(), toggleCol: noop, sortCol: "default", sortDir: "asc", onSort: noop, onPlay() { plays++ }, onAddToQueue: noop, onPlayRadio: noop, columns: [{ id: "rating", label: "Rating" }], searchPlaceholder: "Filter", filterQuery: "", onFilterChange: noop, currentTrackId: "one" }
for (const compact of [false, true]) { await render(<TrackTable {...props} compact={compact} />); const before = plays; await click(named("Play First track")); assert.equal(plays, before + 1); assert.equal(named("Play First track").getAttribute("aria-current"), "true") }
await render(<><QueuePanel /><LyricsPanel /></>)
await click(named("Remove Next track from queue")); assert.equal(removes, 1); assert.equal(jumps, 0)
assert.match(named("Remove Next track from queue").className, /focus-visible:opacity-100/)
await click(named("Play Next track")); assert.equal(jumps, 1)
await click(named("Close queue")); assert.equal(ui.getState().isQueueOpen, false); assert.equal(ui.getState().isLyricsOpen, true)
await click(named("Close lyrics")); assert.equal(ui.getState().isLyricsOpen, false)
await act(async () => player.setState({ currentTrack: null, lyricsLines: null }))
await render(<LyricsContent />); assert.match(document.body.textContent!, /Play a track to see its lyrics/)
await act(async () => player.setState({ currentTrack: track, lyricsLines: null })); assert.match(document.body.textContent!, /Loading lyrics/)
await act(async () => player.setState({ lyricsLines: [] })); assert.match(document.body.textContent!, /No lyrics available/)
await act(async () => { lyrics.setState({ sources: [{ id: "plain", isSynced: false }], activeSourceId: "plain" }); player.setState({ lyricsLines: [{ text: "Plain line", startMs: 0, endMs: 0 }] }) })
assert.equal((document.querySelector("button") as HTMLButtonElement).disabled, true)
await act(async () => { lyrics.setState({ sources: [{ id: "sync", isSynced: true }], activeSourceId: "sync" }) })
await click(named("Seek to Plain line")); assert.equal(seeks, 1)
await act(async () => root.unmount()); dom.window.close()
