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
const library = create(() => ({ hubs: [] as any[] }))
const providers = create(() => ({ provider: null as any }))
let selection = 0
const selectedMixes: any[] = []
mock.module("../../src/stores/libraryStore", () => ({
  useLibraryStore: library,
}))
mock.module("../../src/stores/providerStore", () => ({
  useProviderStore: providers,
}))
mock.module("../../src/hooks/useMixThumbnails", () => ({
  mixThumbnailKey: (item: any) => item.providerKey,
  mixTitleToArtistName: (title: string) => title.replace(/ Mix$/, ""),
  useMixThumbnails: () => ({}),
}))
mock.module("../../src/lib/mixSelection", () => ({
  selectMix: (item: any) => selectedMixes.push(item),
  shuffleTracks: (items: any[]) => items,
}))
const player = create(() => ({
  currentTrack: null,
  playTrack: async (...args: any[]) => {
    plays.push(args)
  },
  playFromUri: async () => {},
  playPlaylist: async () => {},
  addToQueue: (tracks: any[]) => queues.push(tracks),
  playRadio: async (...args: any[]) => {
    radios.push(args)
  },
}))
let hasRadio = false
mock.module("../../src/stores/index", () => ({ useSearchStore: search }))
mock.module("../../src/stores/playerStore", () => ({
  usePlayerStore: player,
  capturePlaybackSelectionVersion: () => selection,
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
    actionsHandler: () => (e: any) => e.preventDefault(),
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
mock.module("../../src/lib/mediaCardInfo", () => ({
  getMediaInfo: (item: any) => ({
    title: item.title,
    desc: item.artistName || item.type,
    thumb: item.thumbUrl,
    isArtist: item.type === "artist",
    href:
      item.type === "track"
        ? `/album/${item.albumId}`
        : `/${item.type}/${item.id}`,
    id: item.id,
    itemType: item.type,
    artistName: item.type === "artist" ? item.title : item.artistName,
    albumName: item.type === "album" ? item.title : item.albumName,
  }),
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
  [
    "/search",
    (path: string) => {
      if (path === "/mix")
        assert.ok(selectedMixes.length, "mix selected before route")
      navigations.push(path)
    },
  ] as const
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
      document.querySelector('button[aria-label="Start radio for Track 0"]'),
      "existing callers' radio default must remain unchanged"
    )
    assert.equal(
      document.querySelector('button[aria-label^="Play "] span')?.textContent,
      "1",
      "default rows retain their number while exposing keyboard playback"
    )
  } else {
    await mount()
    assert.equal(
      document.querySelector("h1")!.textContent,
      "Results for “Yoshiko”"
    )
    if (scenario === "reachability") {
      assert.ok(
        document.body.textContent!.includes("114 results")
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
      await update({ results: [artist(99)] })
      assert.equal(button("Albums").getAttribute("aria-pressed"), "true", "revalidation retains the selected filter")
      await act(async () => providers.setState({ provider: { capabilities: {}, cacheScope: "replacement" } }))
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
      assert.equal(document.querySelector('button[aria-label="Start radio for Track 0"]'), null)
      hasRadio = true
      await update({ results: [...tracks] })
      await click(
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Start radio for Track 0"]'
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
    } else if (scenario === "discovery") {
      let resolveMix!: (tracks: any[]) => void
      const provider = {
        cacheScope: "synthetic-account-a",
        capabilities: { mixTracks: true, stations: true },
        search: async () => [],
        getMixTracks: async () =>
          new Promise<any[]>((resolve) => {
            resolveMix = resolve
          }),
      }
      await act(() => {
        providers.setState({ provider })
        library.setState({
          hubs: [
            {
              identifier: "music.recent.played.5",
              title: "Recent",
              items: [artist(0)],
            },
            {
              identifier: "music.mixes.5",
              title: "Mixes",
              items: Array.from({ length: 7 }, (_, i) => ({
                ...playlist,
                id: "0",
                providerKey: `mix-${i}`,
                title: `Personal ${i} Mix`,
              })),
            },
            {
              identifier: "music.recent.artist.5",
              title: "More by Original Artist",
              items: [album(0)],
            },
          ],
        })
      })
      await update({ query: "", results: [] })
      assert.equal(
        document.querySelectorAll('[aria-label="Made for you"] a').length,
        6
      )
      assert.ok(
        document.querySelector('[aria-label="More by Original Artist"]')
      )
      const mixLink = document.querySelector<HTMLAnchorElement>(
        '[aria-label="Made for you"] a'
      )!
      mixLink.focus()
      assert.equal(document.activeElement, mixLink)
      await act(() =>
        mixLink.dispatchEvent(
          new dom.window.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            detail: 0,
          })
        )
      )
      assert.equal(selectedMixes[0].providerKey, "mix-0")
      assert.equal(navigations.at(-1), "/mix")
      const recent = document.querySelector<HTMLAnchorElement>(
        '[aria-label="Jump back in"] a'
      )!
      assert.equal(recent.getAttribute("href"), "/artist/artist-0")
      await act(() =>
        recent.dispatchEvent(
          new dom.window.MouseEvent("mouseover", { bubbles: true })
        )
      )
      assert.deepEqual(prefetches.at(-1), ["artist", "artist-0"])
      const play = document.querySelector<HTMLButtonElement>(
        '[aria-label="Made for you"] button'
      )!
      await click(play)
      await update({ query: "New query" })
      await act(async () => {
        resolveMix([track(0)])
        await settle()
      })
      assert.equal(
        plays.length,
        0,
        "query transition retires unresolved mix playback"
      )
      await update({ query: "" })
      await click(
        document.querySelector<HTMLButtonElement>(
          '[aria-label="Made for you"] button'
        )!
      )
      await act(async () => {
        selection++
        resolveMix([track(0)])
        await settle()
      })
      assert.equal(
        plays.length,
        0,
        "explicit player selection retires mix lookup"
      )
      await click(
        document.querySelector<HTMLButtonElement>(
          '[aria-label="Made for you"] button'
        )!
      )
      await act(async () => {
        resolveMix([track(0), track(1)])
        await settle()
      })
      assert.equal(plays.length, 1)
      assert.equal(plays[0][1].length, 2)
      const delayedMix = provider.getMixTracks
      provider.getMixTracks = async () => {
        throw new Error("private synthetic transport detail")
      }
      await click(
        document.querySelector<HTMLButtonElement>(
          '[aria-label="Made for you"] button'
        )!
      )
      await act(async () => {
        await settle()
      })
      assert.ok(
        document
          .querySelector('[role="alert"]')!
          .textContent!.includes("Could not play this mix")
      )
      assert.ok(!document.body.textContent!.includes("private synthetic"))
      provider.getMixTracks = delayedMix
      await click(
        document.querySelector<HTMLButtonElement>(
          '[aria-label="Made for you"] button'
        )!
      )
      await act(() => {
        providers.setState({ provider: null })
        library.setState({ hubs: [] })
      })
      await act(async () => {
        resolveMix([track(0)])
        await settle()
      })
      assert.equal(
        plays.length,
        1,
        "departed account cannot start mix playback"
      )
      assert.equal(document.querySelector('[role="alert"]'), null)

      assert.equal(document.querySelector('[aria-label="Made for you"]'), null)
      assert.ok(
        document.body.textContent!.includes("Connect your music library")
      )
      assert.ok(document.querySelector('a[href="/library"]'))
      assert.ok(document.querySelector('a[href="/stations"]'))
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
