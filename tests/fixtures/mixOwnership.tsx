import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import { Router } from "wouter"
import { deferred } from "../helpers/radioAudioFakes"

const scenario = process.argv[2]!
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
globalThis.document = dom.window.document
globalThis.window = dom.window as any
globalThis.localStorage = dom.window.localStorage
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const plays: any[] = []
const player = create(() => ({
  playTrack: async (...args: any[]) => {
    plays.push(args)
  },
  playFromUri: async () => {},
  playRadio() {},
  addToQueue() {},
  currentTrack: null,
}))
const library = create(() => ({
  hubs: [] as any[],
  recentlyAdded: [] as any[],
  latestReleases: [] as any[],
  mixTracksCache: {},
  tagsGenre: [],
  tagsMood: [],
  tagsStyle: [],
  recentMixes: [],
  addRecentMix() {},
}))
const connection = create(() => ({
  isConnected: true,
  isLoading: false,
  musicSectionId: 1,
  sectionUuid: "synthetic-library",
}))
mock.module("../../src/stores/index", () => ({
  useLibraryStore: library,
  usePlayerStore: player,
  useConnectionStore: connection,
}))
mock.module("../../src/stores/playerStore", () => ({ usePlayerStore: player }))
mock.module("../../src/stores/metadataCache", () => ({
  prefetchArtist() {},
  prefetchAlbum() {},
}))
mock.module("../../src/hooks/useContextMenu", () => ({
  useContextMenu: () => ({ handler: () => () => {} }),
}))
mock.module("../../src/hooks/useColumnPicker", () => ({
  ALL_COLUMNS: [],
  usePlaylistColumns: () => ({ visible: [], toggle() {} }),
}))
mock.module("../../src/components/UltraBlur", () => ({ UltraBlur: () => null }))
mock.module("../../src/components/shared/ArtworkImage", () => ({
  ArtworkImage: (props: any) => <img {...props} />,
}))
mock.module("../../src/components/shared/TrackTable", () => ({
  TrackTable: ({ tracks, isLoading, emptyMessage }: any) => (
    <div data-tracks>
      {isLoading
        ? "Loading tracks"
        : tracks.length
          ? tracks.map((track: any) => track.title).join(",")
          : emptyMessage}
    </div>
  ),
}))
mock.module("../../src/components/MediaCard", () => ({
  MediaCard: ({ title, thumb, onPlay }: any) => (
    <div data-card={title} data-thumb={thumb ?? ""}>
      {title}
      <button onClick={onPlay}>Play {title}</button>
    </div>
  ),
}))
mock.module("../../src/components/ScrollRow", () => ({
  ScrollRow: ({ title, children, onPlayAll }: any) => (
    <section>
      {title}
      <button onClick={onPlayAll}>Play all {title}</button>
      {children}
    </section>
  ),
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useMixThumbnails, mixThumbnailKey } =
  await import("../../src/hooks/useMixThumbnails")
const navigation: string[] = []
const location = () =>
  ["/mix", (path: string) => navigation.push(path)] as [
    string,
    (path: string) => void,
  ]
const requests: {
  owner: any
  kind: string
  key: string
  reply: ReturnType<typeof deferred<any>>
}[] = []
function provider() {
  const owner: any = {
    cacheScope: "same-synthetic-scope",
    capabilities: { stations: true, mixTracks: true },
    buildRadioUri: () => "synthetic-radio",
  }
  for (const [method, kind] of [
    ["search", "search"],
    ["getMixTracks", "tracks"],
    ["getSectionStations", "stations"],
    ["getAlbumTracks", "album"],
  ]) {
    owner[method] = (key = "") => {
      const reply = deferred<any>()
      requests.push({ owner, kind: kind!, key, reply })
      return reply.promise
    }
  }
  return owner
}
const first = provider()
useProviderStore.getState().setProvider(first)
const mix = (key = "first", thumb = "https://synthetic.test/source-a") => ({
  type: "playlist" as const,
  id: "0",
  title: "Artist Mix",
  providerKey: key,
  thumbUrl: thumb,
  guid: "synthetic-guid",
  smart: false,
  trackCount: 1,
  duration: null,
  summary: null,
  addedAt: null,
})
const artist = (title = "Artist", thumb = "https://synthetic.test/artist") => ({
  type: "artist",
  id: title,
  title,
  thumbUrl: thumb,
})
const track = (title: string) => ({
  type: "track",
  id: title,
  title,
  artistName: "Artist",
  artistId: "artist",
  albumName: "Album",
  albumId: "album",
  duration: 1,
})
const get = (kind: string) =>
  requests.filter((request) => request.kind === kind)
async function settle(
  request: (typeof requests)[number],
  value: any,
  fail = false
) {
  await act(async () => {
    if (fail) request.reply.reject(value)
    else request.reply.resolve(value)
  })
}
async function input(value: string) {
  const target = document.querySelector("input")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value"
    )!.set!.call(target, value)
    target.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
}
async function debounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 370))
  })
}
const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === text
  )!
let mounted = true
async function unmount() {
  if (mounted) {
    await act(async () => root.unmount())
    mounted = false
  }
}
try {
  if (scenario.startsWith("thumbnail")) {
    function Fixture({ items, twice = false }: any) {
      const owner = useProviderStore((state) => state.provider)
      const values = useMixThumbnails(owner, items)
      return (
        <>
          <div data-thumbnails>{Object.values(values).join(",")}</div>
          {twice && <Other items={items} />}
        </>
      )
    }
    function Other({ items }: any) {
      useMixThumbnails(
        useProviderStore((state) => state.provider),
        items
      )
      return null
    }
    const items =
      scenario.endsWith("batch") || scenario.endsWith("eviction")
        ? Array.from(
            { length: scenario.endsWith("eviction") ? 257 : 20 },
            (_, index) => ({
              ...mix(String(index)),
              title: `Artist ${index} Mix`,
            })
          )
        : [mix()]
    await act(async () =>
      root.render(
        <Fixture items={items} twice={scenario.endsWith("coalescing")} />
      )
    )
    assert.equal(
      get("search").length,
      scenario.endsWith("batch") || scenario.endsWith("eviction") ? 5 : 1
    )
    if (scenario.endsWith("eviction")) {
      let completed = 0
      while (completed < items.length) {
        const batch = get("search").slice(completed)
        assert.ok(batch.length > 0 && batch.length <= 5)
        await act(async () => {
          for (const request of batch) request.reply.resolve([artist()])
        })
        completed += batch.length
      }
      await act(async () => root.render(<Fixture items={[items[0]]} />))
      assert.equal(
        get("search").length,
        258,
        "gallery cache must retire its oldest entry"
      )
    } else if (scenario.endsWith("batch")) {
      await unmount()
      await act(async () => {
        for (const request of get("search")) request.reply.resolve([artist()])
      })
      assert.equal(
        get("search").length,
        5,
        "retired gallery cannot admit later batches"
      )
    } else if (scenario.endsWith("retired")) {
      const second = provider()
      await act(async () => useProviderStore.getState().setProvider(second))
      assert.equal(get("search").length, 2)
      await settle(get("search")[0]!, [
        artist("Artist", "https://synthetic.test/retired"),
      ])
      assert.ok(!document.body.textContent?.includes("retired"))
      await settle(get("search")[1]!, [
        artist("Artist", "https://synthetic.test/current"),
      ])
      assert.ok(document.body.textContent?.includes("current"))
      await act(async () => useProviderStore.getState().setProvider(first))
      assert.equal(
        get("search").length,
        3,
        "retired consumer must not publish old cache"
      )
    } else {
      await settle(get("search")[0]!, [artist()])
      await act(async () =>
        root.render(
          <Fixture
            items={
              scenario.endsWith("identity")
                ? [mix("second", "https://synthetic.test/source-b")]
                : items
            }
          />
        )
      )
      assert.equal(get("search").length, scenario.endsWith("identity") ? 2 : 1)
      if (scenario.endsWith("identity"))
        assert.equal(
          document.querySelector("[data-thumbnails]")!.textContent,
          ""
        )
    }
  } else if (scenario.startsWith("home")) {
    const { Home } = await import("../../src/components/Pages/Home")
    library.setState({
      hubs: [{ identifier: "music.mixes", title: "Mixes", items: [mix()] }],
      recentlyAdded: [
        {
          type: "album",
          id: "album",
          title: "Album",
          artistName: "Artist",
          year: 2020,
        },
      ],
    })
    await act(async () =>
      root.render(
        <Router hook={location}>
          <Home />
        </Router>
      )
    )
    if (scenario.endsWith("source")) {
      await settle(get("search")[0]!, [artist()])
      assert.ok(
        document
          .querySelector("[data-card]")!
          .getAttribute("data-thumb")
          ?.includes("artist")
      )
      await act(async () =>
        library.setState({
          hubs: [
            {
              identifier: "music.mixes",
              title: "Mixes",
              items: [mix("second", "https://synthetic.test/source-b")],
            },
          ],
        })
      )
      assert.equal(get("search").length, 2)
      assert.equal(
        document.querySelector("[data-card]")!.getAttribute("data-thumb"),
        "https://synthetic.test/source-b"
      )
    } else {
      if (scenario.endsWith("hub"))
        await act(async () =>
          library.setState({
            hubs: [
              {
                identifier: "fixture-hub",
                title: "Fixture hub",
                items: library.getState().recentlyAdded,
              },
            ],
          })
        )
      await act(async () =>
        button(
          scenario.endsWith("hub")
            ? "Play all Fixture hub"
            : "Play all Recently Added"
        ).click()
      )
      assert.equal(get("album").length, 1)
      if (scenario.endsWith("latest")) {
        await act(async () => button("Play all Recently Added").click())
        await settle(get("album")[1]!, [track("current playback")])
        await settle(get("album")[0]!, [track("retired playback")])
        assert.equal(plays.length, 1)
        assert.equal(plays[0][0].title, "current playback")
      } else if (scenario.endsWith("error")) {
        await settle(get("album")[0]!, new Error("synthetic"), true)
        assert.ok(document.querySelector('[role="alert"]'))
        assert.equal(plays.length, 0)
      } else {
        await act(async () =>
          useProviderStore.getState().setProvider(provider())
        )
        await settle(get("album")[0]!, [track("retired playback")])
        assert.equal(plays.length, 0)
      }
    }
  } else if (scenario.startsWith("mix")) {
    const { MixPage, selectMix } =
      await import("../../src/components/Pages/Mix")
    selectMix(mix())
    await act(async () =>
      root.render(
        <Router hook={location}>
          <MixPage />
        </Router>
      )
    )
    assert.equal(get("tracks").length, 1)
    if (scenario.endsWith("selection")) {
      await act(async () => selectMix(mix("second")))
      assert.equal(get("tracks").length, 2)
      await settle(get("tracks")[1]!, [track("current track")])
      await settle(get("tracks")[0]!, [track("retired track")])
      assert.equal(
        document.querySelector("[data-tracks]")!.textContent,
        "current track"
      )
    } else if (scenario.endsWith("provider")) {
      const second = provider()
      await act(async () => useProviderStore.getState().setProvider(second))
      await settle(get("tracks")[0]!, [track("retired track")])
      assert.equal(
        get("tracks").length,
        1,
        "old selected key must not be requested in new library"
      )
      assert.ok(document.body.textContent?.includes("No mix selected"))
    } else if (scenario.endsWith("retry")) {
      await settle(get("tracks")[0]!, new Error("synthetic"), true)
      assert.ok(document.querySelector('[role="alert"]'))
      assert.ok(!document.body.textContent?.includes("No tracks found"))
      await act(async () => button("Try again").click())
      await settle(get("tracks")[1]!, [track("recovered track")])
      assert.equal(
        document.querySelector("[data-tracks]")!.textContent,
        "recovered track"
      )
    } else {
      const unsupported = provider()
      unsupported.capabilities.mixTracks = false
      await act(async () =>
        useProviderStore.getState().setProvider(unsupported)
      )
      assert.ok(navigation.includes("/"))
      await act(async () => {
        useProviderStore.getState().setProvider(first)
        selectMix(mix())
      })
      assert.equal(get("tracks").length, 2)
    }
  } else {
    const { StationsPage } = await import("../../src/components/Pages/Stations")
    await act(async () =>
      root.render(
        <Router hook={location}>
          <StationsPage />
        </Router>
      )
    )
    assert.equal(get("stations").length, 1)
    if (scenario.endsWith("provider")) {
      const second = provider()
      await act(async () => useProviderStore.getState().setProvider(second))
      await settle(get("stations")[1]!, [
        { identifier: "station", items: [artist("current station")] },
      ])
      await settle(get("stations")[0]!, [
        { identifier: "station", items: [artist("retired station")] },
      ])
      assert.ok(document.body.textContent?.includes("current station"))
      assert.ok(!document.body.textContent?.includes("retired station"))
    } else if (scenario === "stations-retry") {
      await settle(get("stations")[0]!, new Error("synthetic"), true)
      assert.ok(document.querySelector('[role="alert"]'))
      assert.ok(!document.body.textContent?.includes("No stations available"))
      await act(async () => button("Try again").click())
      await settle(get("stations")[1]!, [])
      assert.ok(document.body.textContent?.includes("No stations available"))
    } else if (scenario.endsWith("capability")) {
      const unsupported = provider()
      unsupported.capabilities.stations = false
      await act(async () =>
        useProviderStore.getState().setProvider(unsupported)
      )
      assert.ok(navigation.includes("/"))
      await act(async () => useProviderStore.getState().setProvider(first))
      assert.equal(get("stations").length, 2)
    } else {
      await input("First")
      await debounce()
      assert.equal(get("search").length, 1)
      if (scenario === "stations-search") {
        await input("Second")
        await debounce()
        await settle(get("search")[1]!, [artist("Second")])
        await settle(get("search")[0]!, [artist("First")])
        assert.ok(document.querySelector('[aria-label="Add Second to mix"]'))
        assert.ok(!document.querySelector('[aria-label="Add First to mix"]'))
      } else if (scenario.endsWith("seeds")) {
        await settle(get("search")[0]!, [artist("First")])
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              '[aria-label="Add First to mix"]'
            )!
            .click()
        )
        assert.ok(document.body.textContent?.includes("Start Mix (1 artist)"))
        await input("Pending")
        await debounce()
        await act(async () =>
          useProviderStore.getState().setProvider(provider())
        )
        assert.equal(
          document.querySelector<HTMLInputElement>("input")!.value,
          ""
        )
        assert.ok(!document.body.textContent?.includes("Start Mix (1 artist)"))
        await settle(get("search")[1]!, [artist("retired seed")])
        assert.ok(!document.body.textContent?.includes("retired seed"))
      } else {
        await settle(get("search")[0]!, new Error("synthetic"), true)
        assert.ok(document.querySelector('[role="alert"]'))
        assert.ok(!document.body.textContent?.includes("No artists found"))
        await act(async () => button("Try again").click())
        await debounce()
        await settle(get("search")[1]!, [artist("First")])
        assert.ok(document.querySelector('[aria-label="Add First to mix"]'))
      }
    }
  }
} finally {
  await unmount()
  dom.window.close()
}
