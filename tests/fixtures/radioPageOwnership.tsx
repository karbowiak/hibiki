import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import { Router } from "wouter"
import { deferred } from "../helpers/radioAudioFakes"
const scenario = process.argv[2]!
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://synthetic.test",
})
globalThis.document = dom.window.document
globalThis.window = dom.window as any
Object.assign(globalThis, { location: dom.window.location, history: dom.window.history })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const requests: {
  kind: string
  key: string
  reply: ReturnType<typeof deferred<any>>
}[] = []
const plays: string[] = []
let selection = 0
const player = create(() => ({
  currentTrack: null,
  isPlaying: true,
  playFromUri: async (uri: string) => {
    selection++
    plays.push(uri)
  },
}))
mock.module("../../src/stores/playerStore", () => ({
  usePlayerStore: player,
  capturePlaybackSelectionVersion: () => selection,
}))
mock.module("../../src/stores/radioStreamStore", () => ({
  useRadioStreamStore: create(() => ({
    favorites: [],
    recentStations: [],
    clearRecent() {},
    playStation: async () => {},
    toggleFavorite() {},
    isFavorite: () => false,
    currentStation: null,
    isStreamPlaying: false,
  })),
}))
mock.module("../../src/components/ScrollRow", () => ({
  ScrollRow: ({ title, children }: any) => (
    <div>
      {title}
      {children}
    </div>
  ),
}))
function request(kind: string, key = "") {
  const reply = deferred<any>()
  requests.push({ kind, key, reply })
  return reply.promise
}
mock.module("../../src/lib/radiobrowser", () => ({
  radiobrowserSearch: (opts: any) =>
    request("lookup", opts.name ?? opts.country ?? opts.tag),
  radiobrowserTopStations: (key: string) => request("featured", key),
  radiobrowserCountries: () => request("countries"),
  radiobrowserTags: () => request("tags"),
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
function provider(name = "first") {
  return {
    capabilities: { radio: true },
    getSectionStations: () => request("plex", name),
    buildRadioUri: (key: string) => `synthetic://${name}/${key}`,
  } as any
}
const first = provider()
useProviderStore.getState().setProvider(first)
const get = (kind: string) => requests.filter((value) => value.kind === kind)
const plexStation = (id: string) => [
  {
    items: [
      {
        type: "playlist",
        id,
        title: id,
        guid: `tv.plex://station/${id}`,
        providerKey: id,
      },
    ],
  },
]
const publicStation = (name: string) => ({
  uuid: name,
  name,
  tags: [],
  country: "",
  countrycode: "",
  codec: "MP3",
  bitrate: 128,
  favicon: "",
  votes: 0,
  url: "https://synthetic.test/audio",
})
async function settle(
  value: (typeof requests)[number],
  result: any,
  fail = false
) {
  await act(async () => {
    if (fail) value.reply.reject(result)
    else value.reply.resolve(result)
  })
}
const navigation: string[] = []
const location = () =>
  ["/radio/fixture", (path: string) => navigation.push(path)] as [
    string,
    (path: string) => void,
  ]
const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (value) => value.textContent?.trim() === text
  )!
async function click(text: string) {
  await act(async () => button(text).click())
}
let mounted = true
async function unmount() {
  if (mounted) {
    await act(async () => root.unmount())
    mounted = false
  }
}
const timers = new Map<number, { run: () => void; delay: number }>()
let timerId = 0
const originalTimeout = globalThis.setTimeout,
  originalClear = globalThis.clearTimeout
globalThis.setTimeout = ((run: () => void, delay: number) => {
  timers.set(++timerId, { run, delay })
  return timerId
}) as any
globalThis.clearTimeout = ((id: number) => timers.delete(id)) as any
async function search(value: string) {
  await act(async () => {
    const target = document.querySelector("input")!
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value"
    )!.set!.call(target, value)
    target.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
  await debounce()
}
async function debounce() {
  const [id, timer] = [...timers].find(([, timer]) => timer.delay === 400)!
  timers.delete(id)
  await act(async () => timer.run())
}
try {
  if (scenario.startsWith("plex")) {
    const { RadioPage } = await import("../../src/components/Pages/Radio")
    async function render(id: string) {
      await act(async () =>
        root.render(
          <Router hook={location}>
            <RadioPage stationType={id} />
          </Router>
        )
      )
    }
    const slug = scenario.endsWith("opaque") ? "literal%2Fstation" : "first"
    await render(slug)
    assert.equal(get("plex").length, 1)
    if (scenario.endsWith("route")) {
      await render("second")
      await settle(get("plex")[1]!, plexStation("second"))
      await settle(get("plex")[0]!, plexStation("first"))
      assert.deepEqual(plays, ["synthetic://first/second"])
      assert.ok(!document.querySelector("h1")!.textContent?.includes("first"))
    } else if (scenario.endsWith("provider")) {
      await act(async () =>
        useProviderStore.getState().setProvider(provider("second"))
      )
      assert.equal(get("plex").length, 2)
      await settle(get("plex")[0]!, plexStation("first"))
      assert.deepEqual(plays, [])
      await settle(get("plex")[1]!, plexStation("first"))
      assert.deepEqual(plays, ["synthetic://second/first"])
    } else if (scenario.endsWith("capability")) {
      await act(async () =>
        useProviderStore
          .getState()
          .setProvider({ capabilities: { radio: false } } as any)
      )
      assert.ok(navigation.includes("/"))
      await settle(get("plex")[0]!, plexStation("first"))
      assert.deepEqual(plays, [])
    } else if (scenario.endsWith("unmount")) {
      await unmount()
      await settle(get("plex")[0]!, plexStation("first"))
      assert.deepEqual(plays, [])
    } else if (scenario.endsWith("retry")) {
      await settle(get("plex")[0]!, new Error("synthetic failure"), true)
      assert.ok(document.querySelector('[role="alert"]'))
      assert.ok(!document.body.textContent?.includes("Station unavailable"))
      await click("Try again")
      await settle(get("plex")[1]!, plexStation("first"))
      assert.deepEqual(plays, ["synthetic://first/first"])
    } else if (scenario.endsWith("selection")) {
      selection++
      await settle(get("plex")[0]!, plexStation("first"))
      assert.deepEqual(plays, [])
      assert.equal(button("Play Station")?.textContent?.trim(), "Play Station")
      await click("Play Station")
      assert.deepEqual(plays, ["synthetic://first/first"])
    } else {
      await settle(get("plex")[0]!, plexStation(slug))
      assert.deepEqual(plays, [`synthetic://first/${slug}`])
    }
  } else {
    const { InternetRadioPage } =
      await import("../../src/components/Pages/InternetRadio")
    await act(async () => root.render(<InternetRadioPage />))
    if (
      scenario === "public-search" ||
      scenario === "public-search-retry" ||
      scenario === "public-unmount"
    ) {
      await search("First")
      if (scenario.endsWith("unmount")) {
        await unmount()
        await settle(get("lookup")[0]!, [publicStation("retired")])
      } else if (scenario.endsWith("retry")) {
        await settle(get("lookup")[0]!, new Error("synthetic"), true)
        assert.ok(document.querySelector('[role="alert"]'))
        assert.ok(!document.body.textContent?.includes("No stations found"))
        await click("Try again")
        await debounce()
        await settle(get("lookup")[1]!, [publicStation("current station")])
        assert.ok(document.body.textContent?.includes("current station"))
      } else {
        await search("Second")
        await settle(get("lookup")[1]!, [publicStation("current station")])
        await settle(get("lookup")[0]!, [publicStation("retired station")])
        assert.ok(document.body.textContent?.includes("current station"))
        assert.ok(!document.body.textContent?.includes("retired station"))
      }
    } else if (scenario === "public-featured-retry") {
      await settle(get("featured")[0]!, new Error("synthetic"), true)
      assert.ok(document.querySelector('[role="alert"]'))
      await click("Try again")
      await act(async () => {
        for (const value of get("featured").slice(3))
          value.reply.resolve([publicStation("recovered station")])
      })
      assert.ok(document.body.textContent?.includes("recovered station"))
      await act(async () => {
        for (const value of get("featured").slice(1, 3))
          value.reply.resolve([publicStation("retired station")])
      })
      assert.ok(!document.body.textContent?.includes("retired station"))
    } else {
      const country = scenario.includes("countr")
      await click(country ? "By Country" : "By Genre")
      const kind = country ? "countries" : "tags"
      const index = country
        ? [
            { name: "First", code: "AA", station_count: 1 },
            { name: "Second", code: "BB", station_count: 1 },
          ]
        : [
            { name: "First", station_count: 1 },
            { name: "Second", station_count: 1 },
          ]
      if (scenario.endsWith("retry")) {
        await settle(get(kind)[0]!, new Error("synthetic"), true)
        assert.ok(document.querySelector('[role="alert"]'))
        await click("Try again")
        await settle(get(kind)[1]!, index)
        assert.ok(document.body.textContent?.includes("First"))
      } else {
        await settle(get(kind)[0]!, index)
        const choose = (name: string) =>
          Array.from(document.querySelectorAll("button")).find((value) =>
            value.textContent?.includes(name)
          )!
        await act(async () => choose("First").click())
        await click(country ? "Back to countries" : "Back to genres")
        await act(async () => choose("Second").click())
        await settle(get("lookup")[1]!, [publicStation("current station")])
        await settle(get("lookup")[0]!, [publicStation("retired station")])
        assert.ok(document.body.textContent?.includes("current station"))
        assert.ok(!document.body.textContent?.includes("retired station"))
      }
    }
  }
} finally {
  await unmount()
  globalThis.setTimeout = originalTimeout
  globalThis.clearTimeout = originalClear
  dom.window.close()
}
