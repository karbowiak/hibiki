import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { renderToStaticMarkup } from "react-dom/server"
const dom = new JSDOM("", { url: "https://hibiki.test" })
dom.window.matchMedia = (() => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
})) as any
globalThis.window = dom.window as any
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
globalThis.location = dom.window.location
const noop = () => {}
const player: any = {
  currentTrack: null,
  queue: [],
  queueIndex: 0,
  volume: 0.5,
  positionMs: 0,
  lyricsLines: [],
  repeat: 0,
  shuffle: false,
  initAudioEvents: async () => {},
  pause: noop,
  resume: noop,
  stop: noop,
  next: noop,
  prev: noop,
  seekTo: noop,
  setVolume: noop,
  toggleMute: noop,
  toggleShuffle: noop,
  cycleRepeat: noop,
  reorderQueue: noop,
  removeFromQueue: noop,
  jumpToQueueItem: noop,
  clearUpcoming: noop,
  addToQueue: noop,
}
const hook = Object.assign((selector: any) => selector(player), {
  getState: () => player,
  setState: noop,
  subscribe: () => noop,
})
mock.module("../../src/stores/index.ts", () => ({ usePlayerStore: hook }))
mock.module("../../src/stores/playerStore", () => ({
  usePlayerStore: hook,
  DJ_MODES: [],
  capturePlaybackSelectionVersion: () => 0,
  isDjGenerated: () => false,
  isRadioGenerated: () => false,
}))
const ui: any = {
  isQueueOpen: false,
  isLyricsOpen: false,
  isQueuePinned: false,
  isLyricsPinned: false,
  queueActiveTab: "queue",
  setQueueOpen: noop,
  setQueuePinned: noop,
  setQueueActiveTab: noop,
  setLyricsOpen: noop,
  setLyricsPinned: noop,
  toggleArtExpanded: noop,
}
mock.module("../../src/stores/uiStore", () => ({
  useUIStore: Object.assign((selector: any) => selector(ui), {
    getState: () => ui,
  }),
}))
mock.module("../../src/audio/RustAudioEngine", () => ({
  engine: { setVisualizerEnabled: noop },
}))
mock.module("../../src/hooks/useCapability", () => ({
  useCapability: (name: string) => name === "lyrics",
}))
mock.module("../../src/hooks/useEasterEggs", () => ({ useEasterEggs: noop }))
mock.module("../../src/hooks/useContextMenu", () => ({
  useContextMenu: () => ({ handler: () => noop }),
}))
mock.module("../../src/hooks/useTrackDrag", () => ({
  useTrackDrag: () => ({}),
}))
mock.module("../../src/hooks/useResizable", () => ({
  useResizable: () => ({ width: 320, onMouseDown: noop, isDragging: false }),
}))
mock.module("../../src/components/VisualizerCanvas", () => ({
  default: () => null,
}))
mock.module("../../src/components/shared/ArtworkImage", () => ({
  ArtworkImage: () => null,
}))
const { Player } = await import("../../src/components/Player")
const { QueuePanel } = await import("../../src/components/QueuePanel")
const { default: LyricsPanel } =
  await import("../../src/components/LyricsPanel")
function markup(element: any) {
  return new JSDOM(renderToStaticMarkup(element)).window.document
}
let doc = markup(<Player />)
assert.match(doc.body.textContent!, /Nothing playing/)
assert.match(doc.body.textContent!, /Choose music from your library/)
assert.equal(doc.querySelector('a[href="#"]'), null)
for (const label of ["Previous track", "Play", "Next track", "Seek"])
  assert.equal(
    doc.querySelector(`[aria-label="${label}"]`)?.hasAttribute("disabled"),
    true,
    label
  )
player.currentTrack = {
  id: "track",
  title: "Selected track",
  artistName: "Artist",
  albumName: "Album",
  duration: 1000,
  albumId: "album",
  thumbUrl: null,
}
doc = markup(<Player />)
assert.equal(
  doc.querySelector('[aria-label="Play"]')?.hasAttribute("disabled"),
  false
)
assert.equal(
  doc.querySelector('[aria-label="Seek"]')?.hasAttribute("disabled"),
  false
)
assert.equal(
  doc.querySelector('h6 a[href="/album/album"]')?.textContent,
  "Selected track"
)
for (const pinned of [false, true])
  for (const open of [false, true]) {
    ui.isQueuePinned = pinned
    ui.isLyricsPinned = pinned
    ui.isQueueOpen = open
    ui.isLyricsOpen = open
    // Standalone lyrics intentionally disappears when queue is pinned.
    doc = markup(<QueuePanel />)
    const queue = doc.querySelector("[aria-hidden]")!
    assert.equal(queue.getAttribute("aria-hidden"), String(!open))
    assert.equal(queue.hasAttribute("inert"), !open)
    ui.isQueuePinned = false
    doc = markup(<LyricsPanel />)
    const lyrics = doc.querySelector("[aria-hidden]")!
    assert.equal(lyrics.getAttribute("aria-hidden"), String(!open))
    assert.equal(lyrics.hasAttribute("inert"), !open)
  }
