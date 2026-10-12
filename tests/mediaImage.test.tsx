import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { useAlbumImage, useArtistImage } from "../src/hooks/useMediaImage"
import { useMetadataSourceStore } from "../src/stores/metadataSourceStore"
import { useDeezerMetadataStore } from "../src/metadata/deezer/store"
import { useItunesMetadataStore } from "../src/metadata/apple/store"

const dom = new JSDOM("<div id='root'></div>")
const previous = { document: globalThis.document, window: globalThis.window, act: (globalThis as any).IS_REACT_ACT_ENVIRONMENT }
const deezerOriginal = useDeezerMetadataStore.getState()
const appleOriginal = useItunesMetadataStore.getState()
const priorityOriginal = useMetadataSourceStore.getState().priority
let root: Root
let requests: string[]
function Harness({ artist = "Artist", plex = "plex-art", failures = [] }: { artist?: string; plex?: string | null; failures?: string[] }) {
  const album = useAlbumImage(artist, "Album", plex, "album-id", failures)
  const image = useArtistImage(artist, plex, "artist-id", failures)
  return <output>{JSON.stringify({ album, image })}</output>
}
async function render(props: { artist?: string; plex?: string | null; failures?: string[] } = {}) {
  await act(async () => { root.render(<Harness {...props} />) })
}
beforeEach(() => {
  globalThis.document = dom.window.document
  globalThis.window = dom.window as unknown as Window & typeof globalThis
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  requests = []
  useDeezerMetadataStore.setState({ artists: {}, albums: {}, _hasHydrated: true,
    getArtist: async name => { requests.push(`deezer-artist:${name}`); return null },
    getAlbum: async name => { requests.push(`deezer-album:${name}`); return null },
  })
  useItunesMetadataStore.setState({ albums: {}, _hasHydrated: true,
    getAlbum: async name => { requests.push(`apple-album:${name}`); return null },
  })
  useMetadataSourceStore.setState({ priority: ["plex", "deezer", "apple"] })
  root = createRoot(document.getElementById("root")!)
})
afterEach(async () => { await act(() => root.unmount()) })
afterAll(() => {
  useDeezerMetadataStore.setState(deezerOriginal)
  useItunesMetadataStore.setState(appleOriginal)
  useMetadataSourceStore.setState({ priority: priorityOriginal })
  globalThis.document = previous.document
  globalThis.window = previous.window
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act
  dom.window.close()
})
test("available Plex art avoids lower-priority artwork requests", async () => {
  await render()
  expect(requests).toEqual([])
})
test("moving Apple above available Plex and Deezer art requests an upgrade", async () => {
  useDeezerMetadataStore.setState({ albums: { "artist::album": { data: { artist: "Artist", title: "Album", cover_url: "https://fixture/deezer" } as any, cachedAt: Date.now() } } })
  await render()
  await act(() => useMetadataSourceStore.setState({ priority: ["apple", "plex", "deezer"] }))
  expect(requests).toEqual(["apple-album:Artist"])
  await act(() => useItunesMetadataStore.setState({ albums: { "artist::album": { data: { artist: "Artist", title: "Album", cover_url: "https://fixture/apple" } as any, cachedAt: Date.now() } } }))
  expect(document.querySelector("output")!.textContent).toContain("fixture%2Fapple")
})
test("Deezer above Plex requests both album and artist upgrades", async () => {
  useMetadataSourceStore.setState({ priority: ["deezer", "plex", "apple"] })
  await render()
  expect(requests).toEqual(["deezer-album:Artist", "deezer-artist:Artist"])
})
test("missing artwork permits fallback requests and hydration gates them", async () => {
  useDeezerMetadataStore.setState({ _hasHydrated: false })
  useItunesMetadataStore.setState({ _hasHydrated: false })
  await render({ plex: null })
  expect(requests).toEqual([])
  await act(() => { useDeezerMetadataStore.setState({ _hasHydrated: true }); useItunesMetadataStore.setState({ _hasHydrated: true }) })
  expect(requests).toEqual(["deezer-album:Artist", "apple-album:Artist", "deezer-artist:Artist"])
})
test("changing entity does not display the previous entity's external image", async () => {
  useMetadataSourceStore.setState({ priority: ["apple", "deezer", "plex"] })
  useItunesMetadataStore.setState({ albums: { "artist::album": { data: { artist: "Artist", title: "Album", cover_url: "https://fixture/old" } as any, cachedAt: Date.now() } } })
  await render()
  expect(document.querySelector("output")!.textContent).toContain("fixture%2Fold")
  await render({ artist: "Other", plex: "new-plex" })
  expect(document.querySelector("output")!.textContent).not.toContain("fixture%2Fold")
  expect(document.querySelector("output")!.textContent).toContain("new-plex")
})

test("failed Plex artwork enables the next preferred provider, then skips a failed Apple image", async () => {
  useMetadataSourceStore.setState({ priority: ["plex", "apple", "deezer"] })
  await render({ failures: ["plex-art"] })
  expect(requests).toContain("apple-album:Artist")
  await act(() => useItunesMetadataStore.setState({ albums: { "artist::album": { data: { artist: "Artist", title: "Album", cover_url: "https://fixture/apple" } as any, cachedAt: Date.now() } } }))
  const appleUrl = JSON.parse(document.querySelector("output")!.textContent!).album
  expect(appleUrl).toContain("fixture%2Fapple")
  await render({ failures: ["plex-art", appleUrl] })
  expect(JSON.parse(document.querySelector("output")!.textContent!).album).toBeNull()
  expect(requests).toContain("deezer-album:Artist")
})
