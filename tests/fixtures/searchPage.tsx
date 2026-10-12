import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { Router } from "wouter"
import { create } from "zustand"
import { settle } from "../helpers/radioAudioFakes"
const scenario = process.argv[2]!
const dom = new JSDOM("<input id='global-query'><div id='root'></div>", {
  url: "https://synthetic.test",
})
globalThis.window = dom.window as any
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const plays: any[][] = [],
  queues: any[] = [],
  radios: any[] = [],
  contexts: any[] = [],
  prefetches: any[] = [],
  drags: any[] = [],
  searches: string[] = []
const search = create(() => ({
  query: "Yoshiko",
  results: [] as any[],
  isSearching: false,
  error: null as string | null,
  search: async (q: string) => {
    searches.push(q)
    search.setState({ query: q, results: [], isSearching: false, error: null })
  },
}))
const player = create(() => ({
  currentTrack: null,
  playTrack: async (...args: any[]) => {
    plays.push(args)
  },
  addToQueue: (tracks: any[]) => queues.push(tracks),
  playRadio: async (...args: any[]) => {
    radios.push(args)
  },
}))
let hasRadio = false
mock.module("../../src/stores/index", () => ({ useSearchStore: search }))
mock.module("../../src/stores/playerStore", () => ({
  usePlayerStore: player,
  prefetchTrackAudio: (track: any) => prefetches.push(["track", track.id]),
}))
mock.module("../../src/stores/metadataCache", () => ({
  prefetchArtist: (id: string) => prefetches.push(["artist", id]),
  prefetchAlbum: (id: string) => prefetches.push(["album", id]),
}))
mock.module("../../src/hooks/useCapability", () => ({
  useCapability: () => hasRadio,
}))
mock.module("../../src/hooks/useMediaImage", () => ({
  useArtistImage: (_name: string, thumb: string | null) => thumb,
  useAlbumImage: (_artist: string, _album: string, thumb: string | null) =>
    thumb,
}))
mock.module("../../src/hooks/useContextMenu", () => ({
  useContextMenu: () => ({
    handler: (type: string, item: any) => (e: any) => {
      e.preventDefault()
      contexts.push([type, item.id])
    },
    isTarget: () => false,
  }),
}))
mock.module("../../src/hooks/useTrackDrag", () => ({
  useTrackDrag: () => ({
    onPointerDown: (_e: any, payload: any) => drags.push(payload),
    onPointerMove() {},
    onPointerUp() {},
  }),
}))
mock.module("../../src/components/Pages/Home", () => ({
  makeDragPayload: (item: any) => ({
    type: item.type,
    ids: [item.id],
    label: item.title,
  }),
}))
mock.module("../../src/components/shared/StarRating", () => ({
  StarRating: () => <span>Rating</span>,
}))
const { Search } = await import("../../src/components/Pages/Search")
const { TrackTable } = await import("../../src/components/shared/TrackTable")
const navigations: string[] = []
const location = () =>
  ["/search", (path: string) => navigations.push(path)] as const
const artist = (index: number) => ({
  type: "artist",
  id: `artist-${index}`,
  title: `Artist ${index}`,
  thumbUrl: null,
})
const album = (index: number) => ({
  type: "album",
  id: `album-${index}`,
  title: `Album ${index}`,
  artistName: "Artist",
  thumbUrl: null,
})
const playlist = {
  type: "playlist",
  id: "playlist-1",
  title: "Playlist",
  thumbUrl: null,
}
const track = (index: number) => ({
  type: "track",
  id: `track-${index}`,
  title: `Track ${index}`,
  artistName: "Artist",
  artistId: "artist-0",
  albumName: `Album ${index % 2}`,
  albumId: "album-0",
  duration: 60000 + index,
  thumbUrl: null,
  userRating: null,
})
const artists = Array.from({ length: 55 }, (_, index) => artist(index))
const tracks = Array.from({ length: 57 }, (_, index) => track(index))
const button = (prefix: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent!.trim().startsWith(prefix)
  )!
async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
    await settle()
  })
}
async function update(value: any) {
  await act(async () => {
    search.setState(value)
    await settle()
  })
}
async function mount() {
  await act(async () => {
    root.render(
      <Router hook={location}>
        <Search />
      </Router>
    )
    await settle()
  })
}
try {
  search.setState({ results: [...artists, album(0), ...tracks, playlist] })
  if (scenario === "default-table") {
    await act(async () =>
      root.render(
        <Router hook={location}>
          <TrackTable
            tracks={[track(0)] as any}
            visibleCols={new Set(["album"])}
            toggleCol={() => {}}
            columns={[{ id: "album", label: "Album" }]}
            sortCol="default"
            sortDir="asc"
            onSort={() => {}}
            onPlay={() => {}}
            onAddToQueue={() => {}}
            onPlayRadio={() => {}}
            filterQuery=""
            onFilterChange={() => {}}
            searchPlaceholder="Existing filter"
          />
        </Router>
      )
    )
    assert.ok(
      document.querySelector('input[placeholder="Existing filter"]'),
      "existing callers must retain their toolbar"
    )
    assert.ok(
      document.querySelector('button[title="Track Radio"]'),
      "existing callers' radio default must remain unchanged"
    )
    assert.equal(
      document.querySelector('button[aria-label^="Play "]'),
      null,
      "compact UI must be opt-in"
    )
  } else {
    await mount()
    assert.equal(
      document.querySelector("h1")!.textContent,
      "Results for “Yoshiko”"
    )
    if (scenario === "reachability") {
      assert.ok(
        document.body.textContent!.includes("114 results in your library")
      )
      const cards = () =>
        document.querySelectorAll(
          'section[aria-labelledby="search-artist-heading"] a'
        )
      assert.equal(cards().length, 24)
      await click(button("Show more artists"))
      assert.equal(cards().length, 48)
      await click(button("Show more artists"))
      assert.equal(cards().length, 55)
      assert.ok(document.querySelector('a[href="/artist/artist-54"]'))
      assert.equal(document.querySelectorAll("tbody tr").length, 50)
      await click(button("Show more tracks"))
      assert.equal(document.querySelectorAll("tbody tr").length, 57)
      assert.ok(document.querySelector('button[aria-label="Play Track 56"]'))
      assert.equal(button("Show more tracks"), undefined)
    } else if (scenario === "filters-reset") {
      await click(button("Albums"))
      assert.equal(document.querySelectorAll("section").length, 1)
      assert.equal(button("Albums").getAttribute("aria-pressed"), "true")
      await update({ results: [artist(99)] }) // a replacement provider can reuse query text
      assert.equal(button("All").getAttribute("aria-pressed"), "true")
      assert.ok(document.querySelector('a[href="/artist/artist-99"]'))
      assert.equal(button("Albums").disabled, true)
      await update({ query: "Next", results: [playlist] })
      assert.equal(
        document.querySelector("h1")!.textContent,
        "Results for “Next”"
      )
      assert.ok(document.querySelector('a[href="/playlist/playlist-1"]'))
    } else if (scenario === "playback") {
      await click(button("Tracks"))
      await click(
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Play Track 0"]'
        )!
      )
      assert.equal(plays.length, 1)
      assert.equal(
        plays[0]![1].length,
        57,
        "queue must contain fetched tracks beyond the visible local page"
      )
      assert.equal(plays[0]![2], "Search: Yoshiko")
      await click(
        document.querySelector<HTMLButtonElement>(
          'button[title="Add to Queue"]'
        )!
      )
      assert.equal(queues[0]![0].id, "track-0")
      assert.equal(
        plays.length,
        1,
        "queue action must not bubble into playback"
      )
      assert.equal(document.querySelector('button[title="Track Radio"]'), null)
      hasRadio = true
      await update({ results: [...tracks] })
      await click(
        document.querySelector<HTMLButtonElement>(
          'button[title="Track Radio"]'
        )!
      )
      assert.deepEqual(radios, [["track-0", "track"]])
      await click(button("Show more tracks"))
      await click(
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Play Track 56"]'
        )!
      )
      assert.equal(plays[1]![0].id, "track-56")
      assert.equal(plays[1]![1].length, 57)
    } else if (scenario === "card-interactions") {
      await update({ results: [artist(0), album(0), playlist] })
      for (const [kind, href] of [
        ["artist", "/artist/artist-0"],
        ["album", "/album/album-0"],
        ["playlist", "/playlist/playlist-1"],
      ]) {
        const card = document.querySelector<HTMLAnchorElement>(
          `a[href="${href}"]`
        )!
        await act(() =>
          card.dispatchEvent(
            new dom.window.MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
            })
          )
        )
        await act(() =>
          card.dispatchEvent(
            new dom.window.MouseEvent("mouseover", { bubbles: true })
          )
        )
        await act(() =>
          card.dispatchEvent(
            new dom.window.MouseEvent("pointerdown", { bubbles: true })
          )
        )
        assert.equal(contexts.at(-1)![0], kind)
        assert.equal(drags.at(-1)!.type, kind)
      }
      assert.deepEqual(prefetches, [
        ["artist", "artist-0"],
        ["album", "album-0"],
      ])
    } else if (scenario === "states-history") {
      await update({ results: [], isSearching: true })
      assert.ok(document.querySelector('[role="status"]'))
      assert.ok(!document.body.textContent!.includes("No results"))
      await update({ isSearching: false, error: "Synthetic search failure" })
      assert.ok(document.querySelector('[role="alert"]'))
      await click(button("Try again"))
      assert.deepEqual(searches, ["Yoshiko"])
      assert.ok(document.body.textContent!.includes("No results for"))
      localStorage.setItem("plex-recent-searches", JSON.stringify(["Previous"]))
      await update({ query: "", results: [], error: null })
      assert.equal(document.querySelector("h1")!.textContent, "Search")
      assert.ok(button("Previous"), "recorded history remains reachable")
      await click(button("Previous"))
      assert.deepEqual(searches, ["Yoshiko", "Previous"])
    } else if (scenario === "compact-shortcut") {
      assert.equal(
        document.querySelector("#root input"),
        null,
        "full search must not add a competing local query toolbar"
      )
      const input = document.querySelector<HTMLInputElement>("#global-query")!
      input.focus()
      const event = new dom.window.KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      await act(() => document.dispatchEvent(event))
      assert.equal(
        event.defaultPrevented,
        false,
        "compact table must not capture the main search shortcut"
      )
      assert.equal(document.activeElement, input)
    }
  }
} finally {
  await act(async () => root.unmount())
  dom.window.close()
}
