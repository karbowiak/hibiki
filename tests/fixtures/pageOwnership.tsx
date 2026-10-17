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
mock.module("../../src/components/MusicLibraryPicker", () => ({ MusicLibraryPicker: () => null }))
mock.module("../../src/stores/metadataCache", () => ({
  prefetchAlbum() {},
  prefetchArtist() {},
  invalidateMetadataItem() {},
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
  if (scenario.startsWith("collection-")) {
    const kind = scenario.split("-")[1]!
    const field = kind === "hubs" ? "hubs" : "recentlyAdded"
    const timestamp = `_${field}FetchedAt`
    const action = kind === "hubs" ? "fetchHubs" : "fetchRecentlyAdded"
    const pending: { owner: any; reply: ReturnType<typeof deferred<void>> }[] =
      []
    library.setState({
      [field]: [],
      [timestamp]: null,
      [action]: () => {
        const reply = deferred<void>()
        pending.push({ owner: useProviderStore.getState().provider, reply })
        return reply.promise
      },
    } as any)
    mock.module("../../src/components/Pages/Home", () => ({
      getMediaInfo: () => null,
      makeDragPayload: () => null,
    }))
    const { HubPage } = await import("../../src/components/Pages/HubPage")
    const { RecentlyAddedPage } =
      await import("../../src/components/Pages/RecentlyAddedPage")
    await act(async () =>
      root.render(
        <Router hook={location}>
          {kind === "hubs" ? (
            <HubPage hubId="missing" />
          ) : (
            <RecentlyAddedPage />
          )}
        </Router>
      )
    )
    assert.equal(pending.length, 1)
    assert.ok(document.querySelector('[role="status"]'))
    const emptyMessage =
      kind === "hubs"
        ? "This collection is unavailable"
        : "Nothing recently added"
    assert.ok(!document.body.textContent?.includes(emptyMessage))
    if (scenario.endsWith("provider")) {
      const second = provider()
      await act(async () => useProviderStore.getState().setProvider(second))
      assert.equal(pending.length, 2)
      assert.equal(pending[1]!.owner, second)
      await act(async () => pending[0]!.reply.reject(new Error("retired")))
      assert.ok(document.querySelector('[role="status"]'))
      assert.ok(!document.querySelector('[role="alert"]'))
    } else {
      await act(async () => pending[0]!.reply.resolve())
      assert.ok(document.querySelector('[role="alert"]'))
      assert.ok(!document.body.textContent?.includes(emptyMessage))
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('[role="alert"] button')!
          .click()
      )
      assert.equal(pending.length, 2)
    }
    await act(async () => {
      library.setState({ [timestamp]: 1 } as any)
      pending[1]!.reply.resolve()
    })
    assert.ok(document.body.textContent?.includes(emptyMessage))
    assert.ok(!document.querySelector('[role="alert"]'))
  } else if (scenario === "library-provider") {
    const owners: any[] = []
    library.setState({
      playlists: [],
      likedTracks: [],
      likedArtists: [],
      likedAlbums: [],
      fetchLikedTracks: async () => {
        owners.push(useProviderStore.getState().provider)
      },
      fetchLikedArtists: async () => {
        owners.push(useProviderStore.getState().provider)
      },
      fetchLikedAlbums: async () => {
        owners.push(useProviderStore.getState().provider)
      },
    } as any)
    mock.module("../../src/components/ScrollRow", () => ({
      ScrollRow: ({ children }: any) => <div>{children}</div>,
    }))
    const { Library } = await import("../../src/components/Pages/Library")
    await act(async () =>
      root.render(
        <Router hook={() => ["/library", () => {}]}>
          <Library />
        </Router>
      )
    )
    assert.equal(owners.length, 3)
    const second = provider()
    await act(async () => useProviderStore.getState().setProvider(second))
    assert.equal(owners.length, 6)
    assert.ok(owners.slice(3).every((owner) => owner === second))
  } else if (scenario.startsWith("liked-")) {
    const kind = scenario.split("-")[1]!
    const pending: { owner: any; reply: ReturnType<typeof deferred<any>>; offset: number; limit: number }[] = []
    const ratedProvider = () => {
      const owner = provider()
      owner.getRatedItemsPage = (_kind: string, offset: number, limit: number) => {
        const reply = deferred<any>()
        pending.push({ owner, reply, offset, limit })
        return reply.promise
      }
      return owner
    }
    const first = ratedProvider()
    useProviderStore.getState().setProvider(first)
    const { useFavoritesStore } = await import("../../src/stores/favoritesStore")
    useFavoritesStore.setState({ loaded: true, loading: false, collection: { ...useFavoritesStore.getState().collection, ratingsImported: true } })
    mock.module("../../src/stores/uiStore", () => ({ useUIStore: ui }))
    mock.module("../../src/hooks/useContextMenu", () => ({
      useContextMenu: () => ({ handler: () => {} }),
    }))
    mock.module("../../src/hooks/useMediaImage", () => ({
      useAlbumImage: () => null,
      useArtistImage: () => null,
    }))
    mock.module("../../src/hooks/useColumnPicker", () => ({
      ALL_COLUMNS: [],
      LIKED_DATE_COLUMN: { id: "liked_at", label: "Date Liked", defaultOn: true },
      usePlaylistColumns: () => ({ visible: [], toggle() {} }),
    }))
    mock.module("../../src/components/shared/TrackTable", () => ({
      TrackTable: ({ paged, emptyMessage, isLoading }: any) => (
        <div>
          {isLoading ? <p role="status">Loading rated songs…</p> : paged.error ? <p role="alert">{paged.error}<button onClick={paged.retry}>Try again</button></p> : paged.total ? Array.from({ length: paged.total }, (_, i) => paged.getItem(i)?.title).join(",") : emptyMessage}
        </div>
      ),
    }))
    const module =
      kind === "tracks"
        ? await import("../../src/components/Pages/Liked")
        : kind === "albums"
          ? await import("../../src/components/Pages/LikedAlbums")
          : await import("../../src/components/Pages/LikedArtists")
    const Page = Object.values(module)[0] as any
    await act(async () =>
      root.render(
        <Router>
          <Page />
        </Router>
      )
    )
    assert.equal(pending.length, 1)
    if(kind==="tracks") await act(async()=>{[...document.querySelectorAll("button")].find(button=>button.textContent==="Rated")!.click()})
    assert.ok(document.querySelector('[role="status"]'))
    assert.ok(!document.body.textContent?.includes("No rated"))
    if (scenario.endsWith("provider")) {
      const second = ratedProvider()
      await act(async () => {
        useProviderStore.getState().setProvider(second)
      })
      assert.equal(pending.length, 2)
      assert.equal(pending[1]!.owner, second)
      await act(async () =>
        pending[0]!.reply.reject(new Error("retired failure"))
      )
      assert.ok(document.querySelector('[role="status"]'))
      assert.ok(!document.querySelector('[role="alert"]'))
      await act(async () => pending[1]!.reply.resolve({ items: [], total: 0, offset: 0 }))
      assert.ok(document.body.textContent?.includes("No rated"))
    } else {
      await act(async () => pending[0]!.reply.reject(new Error("Could not load rated items")))
      assert.ok(document.querySelector('[role="alert"]'))
      assert.ok(!document.body.textContent?.includes("No rated"))
      const retry = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Try again"
      )!
      await act(async () => retry.click())
      assert.equal(pending.length, 2)
      assert.equal(pending[1]!.offset, 0)
      assert.equal(pending[1]!.limit, 200)
      await act(async () => pending[1]!.reply.resolve({ items: [], total: 0, offset: 0 }))
      assert.ok(!document.querySelector('[role="alert"]'))
      assert.ok(document.body.textContent?.includes("No rated"))
    }
  } else if (scenario.startsWith("tag")) {
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
    } else if (scenario === "tag-recovery") {
      await act(async () =>
        requests[0].reply.reject(
          new Error("https://private.test?token=secret-placeholder")
        )
      )
      assert.ok(document.body.textContent!.includes("Could not load albums"))
      assert.ok(!document.body.textContent!.includes("secret-placeholder"))
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('[role="alert"] button')!
          .click()
      )
      await reply(1, [album("Recovered")])
      assert.ok(document.body.textContent!.includes("Recovered"))
      assert.equal(document.querySelector('[role="alert"]'), null)
      await act(async () => ui.setState({ pageRefreshKey: 1 }))
      assert.ok(
        document.body.textContent!.includes("Recovered"),
        "background refresh retains usable albums"
      )
      await act(async () =>
        requests[2].reply.reject(new Error("private-refresh-error"))
      )
      assert.ok(document.body.textContent!.includes("Recovered"))
      assert.ok(!document.body.textContent!.includes("private-refresh-error"))
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
        requests[1].reply.reject(
          new Error("https://private.test?token=secret-placeholder")
        )
      )
      assert.ok(
        document
          .querySelector("[role=alert]")!
          .textContent!.includes("Could not load more albums")
      )
      assert.ok(!document.body.textContent!.includes("secret-placeholder"))
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
  } else if (
    scenario.startsWith("reorder") ||
    scenario === "playlist-load" ||
    scenario === "playlist-smart-sync"
  ) {
    // This fixture exercises playlist transactions without a routed artwork shell.
    mock.module("../../src/components/shared/MediaBackdrop", () => ({
      AmbientHeroBackdrop: () => null,
    }))
    mock.module("../../src/components/Page", () => ({
      useScrollContainer: () => null,
    }))
    mock.module("../../src/components/shared/TrackTable", () => ({
      TrackTable: (props: any) => (
        <div>
          <button
            disabled={!props.onReorder}
            onClick={() => props.onReorder?.(0, 1)}
          >
            Move occurrence
          </button>
          {props.tracks.map((track: any) => (
            <p key={track.playlistItemId}>{track.playlistItemId}</p>
          ))}
        </div>
      ),
    }))
    if (scenario === "playlist-smart-sync") {
      first.name = "Plex"
      first.cacheScope = "smart-scope"
      first.playbackSession = {}
      first.capabilities = { playlists: true, playlistEdit: true }
      first.mutatePlaylistOccurrence = async () => {
        throw Error("No real mutation permitted")
      }
      mock.module(
        "../../src/components/PlaylistSync/LinkedPlaylistManager",
        () => ({
          LinkedPlaylistManager: ({ playlistId }: any) => (
            <p data-sync-config={playlistId}>Smart sync configuration</p>
          ),
        })
      )
    }
    const { Playlist } = await import("../../src/components/Pages/Playlist")
    const songs = [
      {
        id: "same-song",
        title: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 1000,
        playlistItemId: "occurrence-one",
      },
      {
        id: "same-song",
        title: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 1000,
        playlistItemId: "occurrence-two",
      },
    ]
    const playlists: any = {
      "1": {
        id: "1",
        title: "First playlist",
        trackCount: 2,
        smart: scenario === "playlist-smart-sync",
        thumbUrl: null,
      },
      "2": {
        id: "2",
        title: "Second playlist",
        trackCount: 2,
        smart: false,
        thumbUrl: null,
      },
    }
    const fetched: string[] = [],
      invalidated: string[] = [],
      moved: unknown[][] = []
    const movement = deferred<void>()
    let failLoad = scenario === "playlist-load"
    const fetch = async (id: string) => {
      fetched.push(id)
      const cache = (library.getState() as any).playlistItemsCache
      library.setState({
        currentPlaylist: playlists[id],
        currentPlaylistId: id,
        currentPlaylistItems: failLoad ? [] : (cache[id] ?? songs),
        playlistItemsCache: failLoad
          ? {}
          : { ...cache, [id]: cache[id] ?? songs },
        isLoading: false,
        error: failLoad ? "Synthetic load failure" : null,
      } as any)
    }
    library.setState({
      currentPlaylist: null,
      currentPlaylistId: null,
      currentPlaylistItems: [],
      playlistItemsCache: {},
      isLoading: false,
      isFetchingMore: false,
      error: null,
      playlistIsFullyLoaded: { "1": true, "2": true },
      fetchPlaylistItems: fetch,
      fetchMorePlaylistItems: async () => {},
      reorderPlaylistItems: (id: string, from: number, to: number) => {
        const items = [...(library.getState() as any).currentPlaylistItems]
        const [track] = items.splice(from, 1)
        items.splice(to, 0, track)
        library.setState({
          currentPlaylistItems: items,
          playlistItemsCache: {
            ...(library.getState() as any).playlistItemsCache,
            [id]: items,
          },
        } as any)
      },
      invalidatePlaylistItems: (id: string) => {
        invalidated.push(id)
        const cache = { ...(library.getState() as any).playlistItemsCache }
        delete cache[id]
        library.setState({ playlistItemsCache: cache } as any)
        if ((library.getState() as any).currentPlaylistId === id) void fetch(id)
      },
    } as any)
    first.movePlaylistItem = (...args: unknown[]) => {
      moved.push(args)
      return movement.promise
    }
    const render = (id: string) =>
      act(() => root.render(<Playlist playlistId={id} />))
    await render("1")
    if (scenario === "playlist-smart-sync") {
      const sync = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "Sync")!
      assert.ok(sync)
      assert.equal(sync.disabled, true, "Unconfigured sync remains disabled")
      assert.equal(
        [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Move occurrence"
        )!.disabled,
        true
      )
      await act(() =>
        document
          .querySelector<HTMLButtonElement>('button[title="More actions"]')!
          .click()
      )
      const { useContextMenuStore } =
        await import("../../src/stores/contextMenuStore")
      const actions = useContextMenuStore.getState().extraActions
      const configure = actions.find(
        (action: any) => action.label === "Configure sync"
      )
      assert.ok(configure, "Smart playlist must expose Configure sync")
      assert.equal(
        actions.some((action: any) => action.label === "Edit playlist"),
        false
      )
      await act(() => configure.run())
      assert.equal(
        document
          .querySelector("[data-sync-config]")
          ?.getAttribute("data-sync-config"),
        "1"
      )
      assert.deepEqual(moved, [])
    } else if (scenario === "playlist-load") {
      assert.ok(
        document.querySelector("[role=alert]")!.textContent!.includes("songs")
      )
      failLoad = false
      await act(() =>
        [...document.querySelectorAll("button")]
          .find((button) => button.textContent === "Reload playlist")!
          .click()
      )
      assert.equal(document.querySelectorAll("[role=alert]").length, 0)
      assert.ok(document.body.textContent!.includes("occurrence-one"))
    } else {
      await act(() => {
        const button = [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Move occurrence"
        )!
        button.click()
        button.click()
      })
      assert.deepEqual(
        moved,
        [["1", "occurrence-one", "occurrence-two"]],
        "duplicate track IDs must use occurrence IDs and admit only one move"
      )
      if (scenario === "reorder-route") await render("2")
      if (scenario === "reorder-provider") {
        playlists["1"] = { ...playlists["1"], title: "New library playlist" }
        await act(() => useProviderStore.getState().setProvider(provider()))
      }
      if (scenario === "reorder-unmount") await unmount()
      await act(async () => movement.reject(new Error("Move failed")))
      if (scenario === "reorder-recover") {
        assert.deepEqual(invalidated, ["1"])
        assert.deepEqual(
          (library.getState() as any).currentPlaylistItems.map(
            (song: any) => song.playlistItemId
          ),
          ["occurrence-one", "occurrence-two"]
        )
        assert.ok(
          document
            .querySelector("[role=alert]")!
            .textContent!.includes("order could not be saved")
        )
        failLoad = true
        await act(() =>
          [...document.querySelectorAll("button")]
            .find((button) => button.textContent === "Reload playlist")!
            .click()
        )
        assert.ok(
          document.querySelector("[role=alert]")!.textContent!.includes("songs")
        )
      } else {
        assert.deepEqual(
          invalidated,
          [],
          "late recovery must not invalidate or replace the new view"
        )
        if (scenario === "reorder-route") {
          assert.equal((library.getState() as any).currentPlaylistId, "2")
          assert.ok(document.body.textContent!.includes("Second playlist"))
        }
        if (scenario === "reorder-provider")
          assert.ok(document.body.textContent!.includes("New library playlist"))
      }
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
    await act(() => useSearchStore.getState().clear())
    await act(() =>
      window.dispatchEvent(new dom.window.Event("plexify:search-focus"))
    )
    const searchInput = document.querySelector<HTMLInputElement>("input")!
    assert.equal(document.activeElement, searchInput)
    assert.equal(searchInput.getAttribute("aria-expanded"), "true")
    assert.ok(
      document.querySelector('[role="group"][aria-label="Quick actions"]')
    )
    await act(() =>
      searchInput.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        })
      )
    )
    const selectedId = searchInput.getAttribute("aria-activedescendant")!
    assert.ok(
      document.getElementById(selectedId)?.getAttribute("aria-selected") ===
        "true"
    )
    await act(() =>
      searchInput.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      )
    )
    assert.equal(navigation.at(-1), "/library")
    assert.equal(
      calls,
      2,
      "opening and choosing quick actions does not run a library search"
    )
    await act(() =>
      window.dispatchEvent(new dom.window.Event("plexify:search-focus"))
    )
    await act(() =>
      searchInput.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        })
      )
    )
    assert.ok(searchInput.getAttribute("aria-activedescendant"))
    await act(() =>
      library.setState({
        hubs: [
          {
            identifier: "music.recent.played.5",
            items: [
              {
                type: "artist",
                id: "cached",
                title: "Cached Artist",
                thumbUrl: "image://synthetic/cached",
              },
            ],
          },
        ],
      } as any)
    )
    assert.equal(
      searchInput.getAttribute("aria-activedescendant"),
      null,
      "new cached suggestions retire the old keyboard selection"
    )
    await act(() =>
      useProviderStore
        .getState()
        .setProvider({ capabilities: {}, search: async () => [] } as any)
    )
    assert.equal(
      searchInput.getAttribute("aria-expanded"),
      "false",
      "account changes retire the old suggestion panel"
    )
  } else if (scenario === "search-errors") {
    mock.module("../../src/components/Pages/SearchDiscovery", () => ({
      SearchDiscovery: () => null,
    }))
    mock.module("../../src/stores/playerStore", () => ({
      usePlayerStore: player,
      prefetchTrackAudio() {},
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
