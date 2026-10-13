import assert from "node:assert/strict"
import { mock } from "bun:test"
import { act } from "react"
import { JSDOM } from "jsdom"
import { create } from "zustand"
const dom = new JSDOM("<div id='root'></div>", {
  pretendToBeVisual: true,
  url: "https://synthetic.test",
})
globalThis.window = dom.window as any
globalThis.document = dom.window.document
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const library = create(() => ({
  likedArtists: [] as any[],
  likedAlbums: [] as any[],
  latestReleases: [] as any[],
  recentlyAdded: [] as any[],
  hubs: [] as any[],
  likedTracks: [] as any[],
  playlists: [] as any[],
  currentPlaylistId: null as string | null,
  currentPlaylistItems: [] as any[],
}))
mock.module("../../src/stores/libraryStore", () => ({
  useLibraryStore: library,
}))
const { createRoot } = await import("react-dom/client")
const { useAmbientArtwork, useAmbientArtworkClaim } =
  await import("../../src/hooks/useAmbientArtwork")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useArtworkPreferenceStore, artworkPreferenceKey } =
  await import("../../src/stores/artworkPreferenceStore")
const { useMetadataSourceStore } =
  await import("../../src/stores/metadataSourceStore")
const { useDeezerMetadataStore } =
  await import("../../src/metadata/deezer/store")
const { useItunesMetadataStore } =
  await import("../../src/metadata/apple/store")
const { ambientArtworkController } =
  await import("../../src/stores/ambientArtworkStore")
const image = (id: string, scope = "a") =>
  `image://localhost/ext/img?src=${encodeURIComponent(`https://synthetic.test/${id}`)}&scope=${scope}`
const provider = { cacheScope: "a" } as any
useProviderStore.setState({ provider })
useMetadataSourceStore.setState({ priority: ["plex", "deezer", "apple"] })
useArtworkPreferenceStore.setState({ choices: {}, revisions: {} })
let requests = 0
useDeezerMetadataStore.setState({
  artists: {},
  albums: {},
  _hasHydrated: true,
  getArtist: async () => {
    requests++
    return null
  },
  getAlbum: async () => {
    requests++
    return null
  },
})
useItunesMetadataStore.setState({
  albums: {},
  _hasHydrated: true,
  getAlbum: async () => {
    requests++
    return null
  },
})

const { useArtworkAppearanceStore: appearance } =
  await import("../../src/stores/artworkAppearanceStore")
let visibility = "visible"
Object.defineProperty(document, "visibilityState", { get: () => visibility })
const intervals = new Map<number, { fn: () => void; ms: number }>()
const originalSetInterval = globalThis.setInterval,
  originalClearInterval = globalThis.clearInterval
let sequence = 0
;(globalThis as any).setInterval = (fn: () => void, ms: number) => {
  const id = ++sequence
  intervals.set(id, { fn, ms })
  return id
}
;(globalThis as any).clearInterval = (id: number) => {
  intervals.delete(id)
}
let latest: ReturnType<typeof useAmbientArtwork>
function Harness({ route }: { route: string }) {
  latest = useAmbientArtwork(route)
  return null
}
const root = createRoot(document.getElementById("root")!)
const render = async (route = "/search") => {
  await act(() => root.render(<Harness route={route} />))
}
try {
  appearance.setState({
    backgroundArtworkEnabled: true,
    backgroundRotationEnabled: true,
  })
  library.setState({
    latestReleases: [
      { id: "one", title: "One", artistName: "Artist", thumbUrl: image("one") },
      { id: "two", title: "Two", artistName: "Artist", thumbUrl: image("two") },
    ],
  })
  await render()
  assert.equal(latest!.canRotate, true)
  assert.equal(intervals.size, 1)
  assert.equal([...intervals.values()][0].ms, 45_000)
  const initial = latest!.artwork!.src
  await act(() => [...intervals.values()][0].fn())
  assert.notEqual(
    latest!.artwork!.src,
    initial,
    "automatic tick chooses different cached artwork"
  )
  await act(() => appearance.setState({ backgroundRotationEnabled: false }))
  assert.equal(intervals.size, 0)
  const paused = latest!.artwork!.src
  await act(() => latest!.next())
  assert.notEqual(
    latest!.artwork!.src,
    paused,
    "manual next remains available while paused"
  )
  await act(() => appearance.setState({ backgroundRotationEnabled: true }))
  assert.equal(intervals.size, 1)
  await act(() => {
    visibility = "hidden"
    document.dispatchEvent(new window.Event("visibilitychange"))
  })
  assert.equal(
    intervals.size,
    0,
    "hidden windows do not rotate or request images"
  )
  await act(() => {
    visibility = "visible"
    document.dispatchEvent(new window.Event("visibilitychange"))
  })
  assert.equal(intervals.size, 1)
  const oldNext = latest!.next
  await render("/artist/one")
  assert.equal(latest!.canRotate, false)
  assert.equal(intervals.size, 0)
  const artistSource = latest!.artwork!.src
  await act(() => oldNext())
  assert.equal(
    latest!.artwork!.src,
    artistSource,
    "retired route cannot rotate current artwork"
  )
  await render("/album/one")
  assert.equal(latest!.canRotate, false)
  assert.equal(intervals.size, 0)
  await act(() =>
    library.setState({
      currentPlaylistId: "one",
      currentPlaylistItems: ["one", "two"].map((id) => ({
        id,
        albumId: id,
        albumName: id,
        artistName: "Artist",
        albumThumbUrl: image(id),
        artistId: null,
        artistThumbUrl: null,
        thumbUrl: null,
      })),
    })
  )
  await render("/playlist/one")
  assert.equal(latest!.canRotate, true)
  assert.equal(intervals.size, 1)
  const oldAccountNext = latest!.next
  await act(() => {
    library.setState({ latestReleases: [] })
    useProviderStore.setState({ provider: { cacheScope: "b" } as any })
  })
  await act(() => oldAccountNext())
  assert.equal(latest!.artwork, null)
  assert.equal(intervals.size, 0)
  assert.equal(requests, 0, "rotation never discovers external metadata")
} finally {
  await act(() => root.unmount())
  assert.equal(intervals.size, 0)
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
  dom.window.close()
}
