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
  Link: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))
mock.module("../../src/components/shared/ArtworkImage", () => ({
  ArtworkImage: () => null,
  useArtworkFailures: () => ({ failures: [], onFailure() {} }),
}))
mock.module("../../src/hooks/useMediaImage", () => ({
  useArtistImage: (_name: any, thumb: any) => thumb,
  useAlbumImage: (_artist: any, _album: any, thumb: any) => thumb,
}))
const { createRoot } = await import("react-dom/client")
const { SearchDropdown, buildSearchLandingItems } =
  await import("../../src/components/SearchDropdown")
let landingItems: ReturnType<typeof buildSearchLandingItems> = []
let closed = 0
let select: (index: number) => void
function Harness() {
  const [index, setIndex] = useState(0)
  select = setIndex
  return (
    <SearchDropdown
      id="search-results"
      landingItems={landingItems}
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
const popup = document.querySelector('[data-search-scroll]') as HTMLElement
popup.getBoundingClientRect = () => ({ top: 100, bottom: 200 }) as DOMRect
const footer = document.querySelector("[data-search-footer]") as HTMLElement
footer.getBoundingClientRect = () => ({ top: 160, bottom: 200 }) as DOMRect
;(options[2] as HTMLElement).getBoundingClientRect = () =>
  ({ top: 250, bottom: 300 }) as DOMRect
await act(async () => select(2))
assert.equal(popup.scrollTop, 100)
assert.equal(options[2].getAttribute("aria-selected"), "true")
await act(async () => select(3))
assert.equal(
  popup.scrollTop,
  100,
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
// A late provider and a background association refresh leave existing row DOM,
// scroll and the selected action intact. Status is outside the scrolling rows.
const { appendSearchSuggestions } = await import("../../src/lib/searchSuggestions")
state.query = "progressive"
state.suggestions = [{ type: "track", id: "early", title: "Early track", artistName: "A" }]
state.isSearching = true
await act(async () => root.render(<Harness />))
await act(async () => select(0))
const early = document.querySelector('[data-search-index="0"]')!
const scroll = document.querySelector('[data-search-scroll]') as HTMLElement
scroll.scrollTop = 25
state.suggestions = appendSearchSuggestions(state.suggestions, [{ type: "artist", id: "late", title: "Late artist" } as any])
state.isSearching = false
await act(async () => root.render(<Harness />))
assert.equal(document.querySelector('[data-search-index="0"]'), early)
assert.equal(early.getAttribute("aria-selected"), "true")
assert.equal(scroll.scrollTop, 25)
assert.equal(scroll.querySelector('[role="status"]'), null)
await act(async () => select(2)) // footer
state.suggestions = appendSearchSuggestions(state.suggestions, [{ type: "album", id: "later", title: "Later album", artistName: "A" } as any])
await act(async () => root.render(<Harness />))
assert.equal(document.querySelector('[data-search-footer] [role="option"]')!.getAttribute("aria-selected"), "true")
state.suggestions = undefined
state.query = "empty"
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
  document.querySelector('[data-search-scroll] [role="status"]')!.textContent!,
  /No results/
)
assert.equal(document.querySelectorAll('[role="option"]').length, 1)
state.query = ""
landingItems = buildSearchLandingItems(
  [
    {
      identifier: "music.recent.played.5",
      items: [{ type: "artist", id: "return", title: "Return Artist" }],
    } as any,
  ],
  ["Previous", "Previous"],
  false
)
await act(async () => {
  select(0)
  root.render(<Harness />)
})
await act(async () => select(0))
assert.deepEqual(
  [...document.querySelectorAll('[role="group"]')].map((x) =>
    x.getAttribute("aria-label")
  ),
  ["Quick actions", "Recent searches", "Jump back in"]
)
assert.equal(document.querySelectorAll('[role="option"]').length, 6)
assert.ok(!document.body.textContent!.includes("Stations"))
await act(async () =>
  input.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    })
  )
)
assert.equal(navigated.at(-1), "/library")
const searches: string[] = []
state.search = (query: string) => searches.push(query)
await act(async () => select(3))
await act(async () =>
  input.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    })
  )
)
assert.deepEqual(searches, ["Previous"])
assert.equal(navigated.at(-1), "/search")
await act(async () => select(4))
await act(async () =>
  input.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    })
  )
)
assert.equal(navigated.at(-1), "/artist/return")
const richer = buildSearchLandingItems(
  [
    {
      identifier: "music.recent.played.5",
      items: Array.from({ length: 10 }, (_, i) => ({
        type: "artist",
        id: `${i}`,
        title: `Artist ${i}`,
      })),
    } as any,
  ],
  Array.from({ length: 10 }, (_, i) => `Query ${i}`),
  true
)
assert.equal(richer.filter((row) => row.kind === "action").length, 4)
assert.equal(richer.filter((row) => row.kind === "recent").length, 4)
assert.equal(richer.filter((row) => row.kind === "music").length, 3)
await act(async () => root.unmount())
