import { test, expect, mock } from "bun:test"
import { createLibraryStore } from "../src/stores/libraryStore"
import { createVerifiedPlaylistRefresh } from "../src/playlistSync/verifiedPlaylistRefresh"
import type { MusicProvider } from "../src/providers/types"
import type { MusicPlaylist, MusicTrack } from "../src/types/music"
import type { PlaylistSnapshot } from "../src/playlistSync/types"
import { deferred, settle } from "./helpers/radioAudioFakes"
const playlist = (id: string, count = 0) =>
  ({ id, title: id, trackCount: count, smart: false }) as MusicPlaylist
const track = (id: string) => ({ id, title: id }) as MusicTrack
const snapshot = (ids: string[]): PlaylistSnapshot => ({
  account: { service: "library:Plex", user: "scope", revision: "scope-v1" },
  id: "weekly",
  title: "Weekly",
  items: ids.map((id, index) => ({
    occurrenceId: String(index),
    track: { id, title: id, artist: "Artist" },
  })),
})
function provider(): MusicProvider {
  return {
    name: "Plex",
    cacheScope: "scope",
    playbackSession: {},
  } as MusicProvider
}
test("verified sync evicts empty target page, updates count and refreshes only its active view", async () => {
  const origin = provider(),
    before = deferred<any>(),
    after = deferred<any>()
  let reads = 0
  origin.getPlaylistItems = mock(async () =>
    ++reads === 1 ? before.promise : after.promise
  )
  const store = createLibraryStore({
    getProvider: () => origin,
    storage: {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    },
    delay: async () => {},
  })
  await store.getState().activateProvider(origin)
  store.setState({
    playlists: [playlist("weekly"), playlist("other", 1)],
    currentPlaylist: playlist("weekly"),
    currentPlaylistId: "weekly",
    playlistItemsCache: { other: [track("unrelated")] },
    playlistIsFullyLoaded: { other: true },
  })
  const stale = store.getState().fetchPlaylistItems("weekly")
  await settle()
  expect(reads).toBe(1)
  const signal = createVerifiedPlaylistRefresh(origin, () => true, {
    getProvider: () => origin,
    refresh: (id, count) => store.getState().onPlaylistSyncVerified(id, count),
  })
  signal(snapshot(["one", "two"]))
  await settle()
  expect(reads).toBe(2)
  expect(store.getState().currentPlaylist!.trackCount).toBe(2)
  expect(
    store.getState().playlists.find((item) => item.id === "weekly")!.trackCount
  ).toBe(2)
  expect(
    store.getState().playlistItemsCache.other.map((item) => item.id)
  ).toEqual(["unrelated"])
  expect(store.getState().playlistIsFullyLoaded.other).toBe(true)
  before.resolve({ items: [], total: 0 })
  await stale
  expect(store.getState().playlistIsFullyLoaded.weekly).toBeUndefined()
  after.resolve({ items: [track("one"), track("two")], total: 2 })
  await settle()
  expect(store.getState().currentPlaylistItems.map((item) => item.id)).toEqual([
    "one",
    "two",
  ])
  expect(store.getState().playlistIsFullyLoaded.weekly).toBe(true)
})
test("verified refresh fences provider, mutable scope/session and explicit retired operation", () => {
  const origin = provider()
  let active: MusicProvider | null = origin,
    owned = true
  const refresh = mock(() => {})
  const signal = createVerifiedPlaylistRefresh(origin, () => owned, {
    getProvider: () => active,
    refresh,
  })
  signal(snapshot(["one"]))
  expect(refresh).toHaveBeenCalledTimes(1)
  active = provider()
  signal(snapshot(["one"]))
  active = origin
  origin.cacheScope = "other"
  signal(snapshot(["one"]))
  origin.cacheScope = "scope"
  const session = origin.playbackSession
  origin.playbackSession = {}
  signal(snapshot(["one"]))
  origin.playbackSession = session
  owned = false
  signal(snapshot(["one"]))
  owned = true
  signal({
    ...snapshot(["one"]),
    account: { service: "library:Plex", user: "other", revision: "scope-v1" },
  })
  expect(refresh).toHaveBeenCalledTimes(1)
})
test("cache presentation failure cannot change a confirmed mutation outcome", () => {
  const origin = provider()
  const signal = createVerifiedPlaylistRefresh(origin, () => true, {
    getProvider: () => origin,
    refresh: () => {
      throw Error("synthetic blocked cache")
    },
  })
  expect(() => signal(snapshot(["one"]))).not.toThrow()
})

test("verified inactive playlist refresh retains the current view without unrelated network reads", async () => {
  const origin = provider()
  origin.getPlaylistItems = mock(async () => ({ items: [], total: 0 }))
  const store = createLibraryStore({
    getProvider: () => origin,
    storage: {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    },
    delay: async () => {},
  })
  await store.getState().activateProvider(origin)
  store.setState({
    playlists: [playlist("weekly"), playlist("other", 1)],
    currentPlaylist: playlist("other", 1),
    currentPlaylistId: "other",
    currentPlaylistItems: [track("unrelated")],
    playlistItemsCache: { weekly: [], other: [track("unrelated")] },
    playlistIsFullyLoaded: { weekly: true, other: true },
  })
  createVerifiedPlaylistRefresh(origin, () => true, {
    getProvider: () => origin,
    refresh: (id, count) => store.getState().onPlaylistSyncVerified(id, count),
  })(snapshot(["one", "two"]))
  await settle()
  expect(origin.getPlaylistItems).not.toHaveBeenCalled()
  expect(
    store.getState().playlists.find((item) => item.id === "weekly")!.trackCount
  ).toBe(2)
  expect(store.getState().playlistItemsCache.weekly).toBeUndefined()
  expect(store.getState().currentPlaylist!.id).toBe("other")
  expect(store.getState().currentPlaylistItems.map((item) => item.id)).toEqual([
    "unrelated",
  ])
  expect(
    store.getState().playlistItemsCache.other.map((item) => item.id)
  ).toEqual(["unrelated"])
})

test("confirmed description refresh updates hero summary and preserves undefined and retired descriptions", async () => {
  const origin = provider()
  origin.getPlaylistItems = mock(async () => ({ items: [], total: 0 }))
  const store = createLibraryStore({
    getProvider: () => origin,
    storage: {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    },
    delay: async () => {},
  })
  await store.getState().activateProvider(origin)
  const old = {
    ...playlist("weekly", 21),
    summary: "Incomplete: 21/50",
    duration: 123,
    thumbUrl: "managed-art",
  }
  store.setState({
    playlists: [old, { ...playlist("other", 1), summary: "Other summary" }],
    currentPlaylistId: "weekly",
    currentPlaylist: old,
    playlistItemsCache: { other: [track("unrelated")] },
  })
  let owned = true
  const signal = createVerifiedPlaylistRefresh(origin, () => owned, {
    getProvider: () => origin,
    refresh: (id, count, description) =>
      store.getState().onPlaylistSyncVerified(id, count, description),
  })
  const next = {
    ...snapshot(Array.from({ length: 31 }, (_, index) => String(index))),
    description: "Incomplete: 31/50",
  }
  signal(next)
  expect(store.getState().currentPlaylist!.summary).toBe("Incomplete: 31/50")
  expect(store.getState().currentPlaylist!.trackCount).toBe(31)
  expect(store.getState().playlists[0].summary).toBe("Incomplete: 31/50")
  expect(store.getState().currentPlaylist!.duration).toBe(123)
  expect(store.getState().currentPlaylist!.thumbUrl).toBe("managed-art")
  signal(snapshot(["one"]))
  expect(store.getState().currentPlaylist!.summary).toBe("Incomplete: 31/50")
  owned = false
  signal({ ...next, description: "Unconfirmed replacement" })
  expect(store.getState().currentPlaylist!.summary).toBe("Incomplete: 31/50")
  expect(store.getState().playlists[1].summary).toBe("Other summary")
  expect(
    store.getState().playlistItemsCache.other.map((item) => item.id)
  ).toEqual(["unrelated"])
  await settle()
})
