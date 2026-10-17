import assert from "node:assert/strict"
import { mock } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const saved = new Map<string, any>()
mock.module("idb-keyval", () => ({
  createStore: () => ({}),
  get: async (key: string) => saved.get(key),
  set: async (key: string, value: any) => {
    saved.set(key, value)
  },
  update: async (key: string, fn: any) => {
    saved.set(key, fn(saved.get(key)))
  },
  del: async (key: string) => {
    saved.delete(key)
  },
}))
let finishArtist!: (value: any) => void
const artistRequest = new Promise((resolve) => (finishArtist = resolve))
const core = await import("@tauri-apps/api/core")
mock.module("@tauri-apps/api/core", () => ({
  ...core,
  invoke: async (command: string) =>
    command === "lastfm_get_artist_info" ? artistRequest : undefined,
}))
const { createRoot } = await import("react-dom/client")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useFavoritesStore } = await import("../../src/stores/favoritesStore")
const { useFavoriteIndex } = await import("../../src/hooks/useFavoriteIndex")
const { useRatedIndex } = await import("../../src/hooks/useRatedIndex")
let ratedCalls = 0,
  favoriteCalls = 0
const provider: any = {
  cacheScope: "a",
  playbackSession: {},
  getRatedItemsPage: async () => {
    ratedCalls++
    return {
      items: [{ type: "track", id: "1", title: "Account A" }],
      offset: 0,
      total: 1,
    }
  },
  favorites: {
    cachedTracks: async () => {
      favoriteCalls++
      throw Error("Disk read failed")
    },
  },
}
useProviderStore.setState({ provider })
useFavoritesStore.setState((s) => ({
  collection: {
    ...s.collection,
    entries: { a: { id: "a", liked: true, localTrackIds: ["1"] } as any },
  },
}))
let index: any, favorite: any
function View({ revision }: { revision: number }) {
  void revision
  index = useRatedIndex(true)
  useRatedIndex(true)
  favorite = useFavoriteIndex(true)
  return null
}
const root = createRoot(document.getElementById("root")!)
await act(async () => {
  root.render(<View revision={0} />)
  await new Promise((r) => setTimeout(r, 10))
})
assert.equal(ratedCalls, 1)
assert.equal(index.tracks[0].title, "Account A")
assert.equal(favorite.ready, false)
assert.ok(favorite.error)
assert.equal(favorite.tracks.length, 0)
await act(() => {
  provider.cacheScope = "b"
  provider.playbackSession = {}
  provider.getRatedItemsPage = async () => {
    ratedCalls++
    return {
      items: [{ type: "track", id: "2", title: "Account B" }],
      offset: 0,
      total: 1,
    }
  }
  useProviderStore.setState({ provider })
  root.render(<View revision={1} />)
})
assert.equal(ratedCalls, 2)
assert.equal(index.tracks[0].title, "Account B")
provider.favorites.cachedTracks = async () => [
  { id: "1", title: "Available again" },
]
await act(async () => {
  favorite.retry()
  await new Promise((r) => setTimeout(r, 10))
})
assert.equal(favorite.ready, true)
assert.equal(favorite.error, "")
assert.equal(favorite.tracks[0].title, "Available again")
await act(() => root.unmount())
const { useLastfmStore } = await import("../../src/metadata/lastfm/authStore")
const { useLastfmMetadataStore } =
  await import("../../src/metadata/lastfm/store")
useLastfmStore.setState({ hasApiKey: true })
const pending = useLastfmMetadataStore.getState().getArtist("Audit Artist")
useLastfmMetadataStore.getState().clearCache()
finishArtist({
  name: "Audit Artist",
  bio: "late response",
  tags: [],
  similar: [],
})
await pending
assert.equal(useLastfmMetadataStore.getState().stats().artistCount, 0)
dom.window.close()
