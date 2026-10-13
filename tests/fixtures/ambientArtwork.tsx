import assert from "node:assert/strict"
import { mock } from "bun:test"
import { act } from "react"
import { JSDOM } from "jsdom"
import { create } from "zustand"
const dom = new JSDOM("<div id='root'></div>", {
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
}))
mock.module("../../src/stores/libraryStore", () => ({
  useLibraryStore: library,
}))
const { useMetadataIdentityStore } =
  await import("../../src/stores/metadataIdentityStore")
useMetadataIdentityStore.setState({ choices: {}, versions: {}, hydrated: true })
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
let picks = 0
const random = Math.random
Math.random = () => {
  picks++
  return 0
}
let latest: ReturnType<typeof useAmbientArtwork>,
  failures = 0
function Detail({ route, source }: { route: string; source: string }) {
  useAmbientArtworkClaim("detail", {
    src: source,
    route,
    position: "20% 30%",
    align: {
      heroW: 600,
      heroH: 350,
      heroTop: 80,
      heroLeft: 240,
      scrollTop: 20,
    },
    onFailure: () => failures++,
  })
  return null
}
function Harness({
  route = "/search",
  detail = false,
  tick = 0,
}: {
  route?: string
  detail?: boolean
  tick?: number
}) {
  latest = useAmbientArtwork(route)
  return (
    <>
      <output data-tick={tick}>{JSON.stringify(latest.artwork)}</output>
      {detail && (
        <Detail route={route} source={image("detail", provider.cacheScope)} />
      )}
    </>
  )
}
const root = createRoot(document.getElementById("root")!)
const render = async (props: Parameters<typeof Harness>[0] = {}) => {
  await act(() => root.render(<Harness {...props} />))
}
try {
  await render()
  assert.equal(latest!.artwork, null)
  await act(() =>
    library.setState({
      latestReleases: [
        {
          id: "one",
          title: "One",
          artistName: "Artist",
          thumbUrl: image("one"),
        },
        {
          id: "two",
          title: "Two",
          artistName: "Artist",
          thumbUrl: image("two"),
        },
      ],
    })
  )
  assert.equal(latest!.artwork!.src, image("one"))
  const stable = latest!.artwork
  const firstVisitPicks = picks
  await render({ tick: 1 })
  await render({ tick: 2 })
  assert.equal(latest!.artwork, stable)
  assert.equal(
    picks,
    firstVisitPicks,
    "ordinary rerenders do not redraw the route image"
  )
  assert.equal(requests, 0)
  await act(() => {
    useArtworkPreferenceStore
      .getState()
      .setChoice(artworkPreferenceKey("a", "album", "Artist", "One")!, "apple")
  })
  assert.equal(
    latest!.artwork!.src,
    image("one"),
    "missing preferred source uses cached fallback without lookup"
  )
  assert.equal(requests, 0)
  const beforeUpgradeFailure = latest!.onFailure
  const beforeUpgradeSource = latest!.artwork!.src
  await act(() =>
    useItunesMetadataStore.setState({
      albums: {
        "artist::one": {
          data: {
            artist: "Artist",
            title: "One",
            cover_url: "https://synthetic.test/apple",
          } as any,
          cachedAt: Date.now(),
        },
      },
    })
  )
  assert.ok(latest!.artwork!.src.includes("synthetic.test%2Fapple"))
  const selected = latest!.artwork!.src
  await act(() => beforeUpgradeFailure(beforeUpgradeSource))
  assert.ok(
    !ambientArtworkController.store
      .getState()
      .failed.includes(beforeUpgradeSource),
    "late prior-source failures cannot retire an upgraded source"
  )
  await act(() => latest!.onFailure(selected))
  assert.equal(
    latest!.artwork!.src,
    image("one"),
    "failed preferred source preserves stable same-item fallback"
  )
  await render({ detail: true })
  assert.equal(latest!.artwork!.origin, "detail")
  const detailFailure = latest!.onFailure,
    detailSource = latest!.artwork!.src
  await render()
  assert.equal(
    latest!.artwork!.src,
    image("one"),
    "detail cleanup resumes the same route pool"
  )
  await act(() => detailFailure(detailSource))
  assert.equal(failures, 0, "retired detail callback is inert")
  const oldFailure = latest!.onFailure,
    oldSource = latest!.artwork!.src
  await render({ route: "/library" })
  assert.equal(picks, firstVisitPicks + 1)
  await act(() => oldFailure(oldSource))
  assert.equal(
    latest!.artwork!.src,
    image("one"),
    "prior route failure cannot retire current visit"
  )
  await render({ route: "/library", detail: true })
  await act(() => latest!.onFailure(latest!.artwork!.src))
  assert.equal(failures, 1)
  assert.equal(latest!.artwork!.origin, "pool")
  await render({ route: "/library" })
  await act(() => latest!.onFailure(latest!.artwork!.src))
  assert.equal(
    latest!.artwork!.src,
    image("two"),
    "a broken item advances once to another loaded candidate"
  )
  const retired = latest!.onFailure,
    retiredSrc = latest!.artwork!.src
  await act(() => {
    provider.cacheScope = "b"
    useProviderStore.setState({ provider })
  })
  assert.equal(
    latest!.artwork,
    null,
    "old scoped URLs cannot appear under another library"
  )
  await act(() => retired(retiredSrc))
  assert.deepEqual(ambientArtworkController.store.getState().failed, [])
  assert.equal(requests, 0)
  await act(() =>
    library.setState({
      latestReleases: Array.from({ length: 7 }, (_, i) => ({
        id: `b-${i}`,
        title: `B ${i}`,
        artistName: "Artist",
        thumbUrl: image(`b-${i}`, "b"),
      })),
    })
  )
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.ok(latest!.artwork)
    await act(() => latest!.onFailure(latest!.artwork!.src))
  }
  assert.equal(
    latest!.artwork,
    null,
    "five failed picks degrade to a stable empty background"
  )
  await render({ route: "/library", tick: 99 })
  assert.equal(
    latest!.artwork,
    null,
    "unrelated renders do not restart an exhausted visit"
  )
  await render({ route: "/settings" })
  assert.ok(
    latest!.artwork,
    "a new route visit can choose another non-broken cached item"
  )
  assert.equal(requests, 0)
} finally {
  await act(() => root.unmount())
  Math.random = random
  dom.window.close()
}
