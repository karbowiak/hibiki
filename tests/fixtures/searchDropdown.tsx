import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act, useState } from "react"
const dom = new JSDOM(
  "<input data-library-search='true'><div id='root'></div>",
  { url: "https://hibiki.test/" }
)
globalThis.window = dom.window as any
globalThis.document = dom.window.document
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const navigated: string[] = [],
  played: string[] = []
const state: any = {
  query: "test",
  results: [
    {
      id: "same",
      type: "track",
      title: "Track",
      artistName: "Artist",
      albumName: "Album",
    },
    { id: "same", type: "album", title: "Album", artistName: "Artist" },
    { id: "same", type: "artist", title: "Artist" },
  ],
  isSearching: false,
  error: null,
  search() {},
}
mock.module("../../src/stores", () => ({
  useSearchStore: (selector: any) => selector(state),
}))
mock.module("../../src/stores/playerStore", () => ({
  usePlayerStore: (selector: any) =>
    selector({ playTrack: (track: any) => played.push(track.id) }),
}))
mock.module("wouter", () => ({
  useLocation: () => ["/", (href: string) => navigated.push(href)],
}))
mock.module("../../src/components/shared/ArtworkImage", () => ({
  ArtworkImage: () => null,
}))
const { createRoot } = await import("react-dom/client")
const { SearchDropdown } = await import("../../src/components/SearchDropdown")
let closed = 0
let select: (index: number) => void
function Harness() {
  const [index, setIndex] = useState(0)
  select = setIndex
  return (
    <SearchDropdown
      id="search-results"
      activeIndex={index}
      onActiveIndexChange={setIndex}
      onClose={() => closed++}
    />
  )
}
const root = createRoot(document.getElementById("root")!)
await act(async () => root.render(<Harness />))
assert.deepEqual(
  [...document.querySelectorAll('[role="group"]')].map((element) =>
    element.getAttribute("aria-label")
  ),
  ["Artists", "Albums", "Tracks"]
)
const options = [...document.querySelectorAll('[role="option"]')]
assert.equal(options.length, 4)
assert.equal(new Set(options.map((element) => element.id)).size, 4)
assert.equal(options[0].getAttribute("aria-selected"), "true")
const popup = document.querySelector('[role="listbox"]') as HTMLElement
popup.getBoundingClientRect = () => ({ top: 100, bottom: 200 }) as DOMRect
const footer = document.querySelector("[data-search-footer]") as HTMLElement
footer.getBoundingClientRect = () => ({ top: 160, bottom: 200 }) as DOMRect
;(options[2] as HTMLElement).getBoundingClientRect = () =>
  ({ top: 250, bottom: 300 }) as DOMRect
await act(async () => select(2))
assert.equal(popup.scrollTop, 140)
assert.equal(options[2].getAttribute("aria-selected"), "true")
await act(async () => select(3))
assert.equal(
  popup.scrollTop,
  140,
  "sticky footer selection should not scroll result rows"
)
assert.equal(options[3].getAttribute("aria-selected"), "true")
await act(async () => select(0))
const input = document.querySelector("input")!
input.focus()
await act(async () =>
  input.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    })
  )
)
assert.deepEqual(navigated, ["/artist/same"])
await act(async () => (options[1] as HTMLElement).click())
assert.deepEqual(navigated, ["/artist/same", "/album/same"])
await act(async () => (options[2] as HTMLElement).click())
assert.deepEqual(played, ["same"])
assert.equal(document.activeElement, input)
await act(async () => (options[3] as HTMLElement).click())
assert.equal(navigated.at(-1), "/search")
assert.equal(closed, 4)
state.results = []
state.isSearching = true
await act(async () => root.render(<Harness />))
assert.equal(
  document.querySelector('[role="listbox"]')?.getAttribute("aria-busy"),
  "true"
)
assert.match(
  document.querySelector('[role="status"]')!.textContent!,
  /Searching/
)
state.isSearching = false
await act(async () => root.render(<Harness />))
assert.match(
  document.querySelector('[role="status"]')!.textContent!,
  /No results/
)
assert.equal(document.querySelectorAll('[role="option"]').length, 0)
await act(async () => root.unmount())
