import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import { Router } from "wouter"
import { deferred } from "../helpers/radioAudioFakes"

const scenario = process.argv[2]
const dom = new JSDOM(
  "<button id='trigger'>Open</button><div id='root'></div>",
  { url: "https://hibiki.test" }
)
globalThis.document = dom.window.document
globalThis.window = dom.window as any
globalThis.localStorage = dom.window.localStorage
globalThis.getComputedStyle = dom.window.getComputedStyle
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const ui = create(() => ({
  pageRefreshKey: 0,
  isRefreshing: false,
  setIsRefreshing() {},
  incrementPageRefreshKey() {},
}))
const player = create(() => ({ playFromUri() {} }))
const { useSearchStore } = await import("../../src/stores/searchStore")
const library = create(() => ({
  wsConnected: true,
  refreshAll: async () => {},
  invalidateCache() {},
  createPlaylist: async (_name: string): Promise<any> => null,
}))
mock.module("../../src/stores/index.ts", () => ({
  useUIStore: ui,
  usePlayerStore: player,
  useLibraryStore: library,
  useSearchStore,
  useConnectionStore: create(() => ({
    musicSectionId: "1",
    isConnected: true,
  })),
}))
mock.module("../../src/stores/metadataCache", () => ({
  prefetchAlbum() {},
  prefetchArtist() {},
}))
mock.module("../../src/components/MediaCard", () => ({
  MediaCard: ({ title }: any) => <a>{title}</a>,
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const album = (id: string) => ({
  id,
  type: "album",
  title: id,
  artistName: "Artist",
  thumbUrl: null,
})
const requests: {
  tag: string
  offset: number
  reply: ReturnType<typeof deferred<any>>
}[] = []
function provider() {
  return {
    capabilities: { tags: true },
    getItemsByTag: (
      _type: string,
      tag: string,
      _media: string,
      _size: number,
      offset: number
    ) => {
      const reply = deferred<any>()
      requests.push({ tag, offset, reply })
      return reply.promise
    },
  } as any
}
const first = provider()
useProviderStore.getState().setProvider(first)
const navigation: string[] = []
const location = () =>
  ["/genre/First", (path: string) => navigation.push(path)] as [
    string,
    (path: string) => void,
  ]
let mounted = true
async function unmount() {
  if (mounted) {
    await act(() => root.unmount())
    mounted = false
  }
}
try {
  if (scenario.startsWith("tag")) {
    const { TagPage } = await import("../../src/components/Pages/TagPage")
    const observers: { notify: () => void; active: boolean }[] = []
    globalThis.IntersectionObserver = class {
      state: { notify: () => void; active: boolean }
      constructor(callback: any) {
        this.state = {
          notify: () => callback([{ isIntersecting: true }]),
          active: true,
        }
        observers.push(this.state)
      }
      observe() {}
      disconnect() {
        this.state.active = false
      }
    } as any
    const render = (name: string) =>
      act(() =>
        root.render(
          <Router hook={location}>
            <TagPage tagType="genre" tagName={name} />
          </Router>
        )
      )
    const reply = (index: number, items: any[], total = items.length) =>
      act(async () => {
        requests[index].reply.resolve({ items, total })
      })
    await render("First")
    if (scenario === "tag-route") {
      await render("Second")
      await reply(1, [album("Current")])
      await act(async () =>
        requests[0].reply.reject(new Error("Obsolete request failed"))
      )
      assert.ok(document.body.textContent!.includes("Current"))
      assert.ok(!document.body.textContent!.includes("Obsolete"))
      assert.equal(document.querySelectorAll("[role=alert]").length, 0)
    } else if (scenario === "tag-provider") {
      await act(() => useProviderStore.getState().setProvider(provider()))
      assert.equal(requests.length, 2)
      await reply(1, [album("New library")])
      await reply(0, [album("Old library")])
      assert.ok(document.body.textContent!.includes("New library"))
      assert.ok(!document.body.textContent!.includes("Old library"))
    } else if (scenario === "tag-pagination") {
      await reply(0, [album("Initial")], 5)
      const observer = observers.findLast((value) => value.active)!
      await act(() => {
        observer.notify()
        observer.notify()
      })
      assert.equal(
        requests.length,
        2,
        "same-frame observer events must not double-fetch"
      )
      await act(async () =>
        requests[1].reply.reject(new Error("Temporary failure"))
      )
      assert.ok(
        document
          .querySelector("[role=alert]")!
          .textContent!.includes("Temporary failure")
      )
      assert.ok(document.body.textContent!.includes("Initial"))
      const retry = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Try loading")
      )!
      await act(() => retry.click())
      assert.equal(
        requests[2].offset,
        1,
        "retry must retain the failed page offset"
      )
      await render("Second")
      await reply(3, [album("Current")])
      await reply(2, [album("Stale page")], 5)
      assert.ok(!document.body.textContent!.includes("Stale page"))
    } else if (scenario === "tag-offset") {
      await reply(0, [album("Initial"), { id: "ignored", type: "track" }], 10)
      await act(() => observers.findLast((value) => value.active)!.notify())
      assert.equal(requests[1].offset, 2)
      await reply(1, [album("Initial"), album("Next")], 10)
      assert.equal(
        [...document.querySelectorAll("a")].filter(
          (link) => link.textContent === "Initial"
        ).length,
        1
      )
      await act(() => observers.findLast((value) => value.active)!.notify())
      assert.equal(requests[2].offset, 4)
      await reply(2, [], 10)
      assert.ok(
        ![...document.querySelectorAll("button")].some((button) =>
          button.textContent?.includes("Load more")
        )
      )
    } else if (scenario === "tag-capability") {
      await reply(0, [album("Initial")])
      await act(() =>
        useProviderStore
          .getState()
          .setProvider({ capabilities: { tags: false } } as any)
      )
      assert.ok(navigation.includes("/"))
    }
  } else if (scenario === "search-topbar") {
    mock.module("../../src/metadata", () => ({ metadataBackends: [] }))
    mock.module("../../src/lib/imageCache", () => ({
      clearImageCache: async () => {},
    }))
    mock.module("../../src/components/ActivityIndicator", () => ({
      ActivityIndicator: () => null,
    }))
    mock.module("../../src/stores/playerStore", () => ({
      usePlayerStore: player,
    }))
    const { TopBar } = await import("../../src/components/TopBar")
    const timers = new Map<number, () => void>()
    let id = 0,
      calls = 0
    globalThis.setTimeout = ((run: () => void) => {
      timers.set(++id, run)
      return id
    }) as any
    globalThis.clearTimeout = ((value: number) => timers.delete(value)) as any
    const runTimers = () =>
      act(async () => {
        const pending = [...timers.values()]
        timers.clear()
        for (const run of pending) run()
      })
    useProviderStore.getState().setProvider({
      capabilities: {},
      search: async () => {
        calls++
        return []
      },
    } as any)
    await act(() =>
      root.render(
        <Router hook={location}>
          <TopBar />
        </Router>
      )
    )
    await act(async () => useSearchStore.getState().search("Recent"))
    assert.equal(document.querySelector("input")!.value, "Recent")
    await runTimers()
    assert.equal(
      calls,
      1,
      "completed explicit searches must not debounce a duplicate request"
    )
    await act(() =>
      useProviderStore.getState().setProvider({
        capabilities: {},
        search: async () => {
          calls++
          return []
        },
      } as any)
    )
    assert.equal(document.querySelector("input")!.value, "")
    await act(() => {
      const input = document.querySelector("input")!
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, "New")
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    })
    await runTimers()
    assert.equal(calls, 2)
    assert.equal(useSearchStore.getState().query, "New")
  } else if (scenario === "search-errors") {
    mock.module("../../src/stores/playerStore", () => ({
      usePlayerStore: player,
    }))
    mock.module("../../src/hooks/useContextMenu", () => ({
      useContextMenu: () => ({ handler: () => () => {} }),
    }))
    mock.module("../../src/components/Pages/Home", () => ({
      makeDragPayload: () => undefined,
    }))
    const { Search } = await import("../../src/components/Pages/Search")
    const { SearchDropdown } =
      await import("../../src/components/SearchDropdown")
    let fail = true
    let calls = 0
    useProviderStore.getState().setProvider({
      capabilities: {},
      search: async () => {
        calls++
        if (fail) throw new Error("Temporary search failure")
        return []
      },
    } as any)
    await useSearchStore.getState().search("Query")
    await act(() =>
      root.render(
        <Router hook={location}>
          <Search />
          <SearchDropdown
            activeIndex={0}
            onActiveIndexChange={() => {}}
            onClose={() => {}}
          />
        </Router>
      )
    )
    assert.equal(document.querySelectorAll("[role=alert]").length, 2)
    assert.ok(!document.body.textContent!.includes("No results"))
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again"
    )!
    await act(() =>
      retry.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      )
    )
    assert.equal(
      navigation.length,
      0,
      "retry keyboard events must not activate a highlighted search result"
    )
    fail = false
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Try again")!
        .click()
    )
    assert.equal(calls, 2)
    assert.equal(document.querySelectorAll("[role=alert]").length, 0)
    assert.ok(document.body.textContent!.includes("No results"))
  } else {
    const { CreatePlaylist } =
      await import("../../src/components/Pages/CreatePlaylist")
    const pending: ReturnType<typeof deferred<any>>[] = []
    const names: string[] = []
    library.setState({
      createPlaylist: (name) => {
        names.push(name)
        const request = deferred<any>()
        pending.push(request)
        return request.promise
      },
    })
    const timers = new Map<number, { run: () => void; delay: number }>()
    let timerId = 0
    globalThis.setTimeout = ((run: () => void, delay: number) => {
      timers.set(++timerId, { run, delay })
      return timerId
    }) as any
    globalThis.clearTimeout = ((id: number) => timers.delete(id)) as any
    let created = 0,
      closed = 0
    const trigger = document.getElementById("trigger")!
    trigger.focus()
    const render = () =>
      act(() =>
        root.render(
          <CreatePlaylist
            onClose={() => {
              closed++
            }}
            onCreated={() => {
              created++
              if (scenario === "playlist-followup")
                throw new Error("Follow-up failed")
            }}
          />
        )
      )
    const submit = () => {
      const form = document.querySelector("form")!
      form.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true })
      )
    }
    const name = async () =>
      act(() => {
        const input = document.querySelector("input")!
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value"
        )!.set!.call(input, "  My playlist  ")
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
      })
    await render()
    await name()
    if (scenario === "playlist-followup") {
      await act(submit)
      await act(async () => pending[0].resolve({ id: "created" }))
      assert.equal(created, 1)
      assert.ok(
        document
          .querySelector("[role=status]")!
          .textContent!.includes("created")
      )
      assert.ok(
        document
          .querySelector("[role=alert]")!
          .textContent!.includes("Follow-up failed")
      )
      assert.equal(timers.size, 0)
      assert.equal(document.querySelectorAll("form").length, 0)
    } else if (scenario === "playlist-double") {
      await act(() => {
        submit()
        submit()
      })
      assert.deepEqual(names, ["My playlist"])
      await act(async () =>
        pending[0].resolve({ id: "created", title: "My playlist" })
      )
      assert.equal(created, 1)
      assert.ok(
        document
          .querySelector("[role=status]")!
          .textContent!.includes("created")
      )
      await unmount()
      assert.equal(timers.size, 0, "unmount must cancel delayed close")
      assert.equal(closed, 0)
    } else if (scenario === "playlist-unmount") {
      await act(submit)
      await unmount()
      await act(async () => pending[0].resolve({ id: "created" }))
      assert.equal(created, 0)
      assert.equal(closed, 0)
      assert.equal(timers.size, 0)
    } else if (scenario === "playlist-provider") {
      await act(submit)
      await act(() => useProviderStore.getState().setProvider(provider()))
      await act(async () => pending[0].reject(new Error("Old error")))
      assert.equal(created, 0)
      assert.equal(
        closed,
        1,
        "library changes must dismiss the old playlist creation flow"
      )
      assert.equal(document.querySelectorAll("[role=alert]").length, 0)
      assert.equal(document.querySelector("input")!.disabled, false)
    } else if (scenario === "playlist-focus") {
      const dialog = document.querySelector("dialog")!
      assert.equal(dialog.getAttribute("aria-modal"), "true")
      assert.ok(
        document
          .getElementById(dialog.getAttribute("aria-labelledby")!)!
          .textContent!.includes("Create playlist")
      )
      assert.equal(document.activeElement, document.querySelector("input"))
      trigger.focus()
      assert.equal(document.activeElement, document.querySelector("input"))
      const buttons = [...dialog.querySelectorAll("button")]
      buttons.at(-1)!.disabled = false
      buttons.at(-1)!.focus()
      await act(() =>
        buttons.at(-1)!.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Tab",
            bubbles: true,
            cancelable: true,
          })
        )
      )
      assert.equal(document.activeElement, buttons[0])
      await act(() =>
        dialog.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          })
        )
      )
      assert.equal(closed, 1)
      await unmount()
      assert.equal(document.activeElement, trigger)
      assert.equal(document.getElementById("root")!.getAttribute("inert"), null)
    }
  }
} finally {
  await unmount()
  dom.window.close()
}
