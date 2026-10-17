import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { create } from "zustand"
import { deferred, settle } from "../helpers/radioAudioFakes"

const kind = process.argv[2] as "artist" | "album"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test/" })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const ui = create(() => ({ pageRefreshKey: 0, deduplicateAlbums: true }))
mock.module("../../src/stores/uiStore", () => ({ useUIStore: ui }))
const player = create(() => ({ currentTrack: null }))
const library = create(() => ({ tagsGenre: [], tagsMood: [], tagsStyle: [] }))
mock.module("../../src/stores/index.ts", () => ({
  useUIStore: ui,
  usePlayerStore: player,
  useLibraryStore: library,
}))
mock.module("../../src/stores/playerStore", () => ({
  usePlayerStore: player,
  prefetchTrackAudio() {},
}))
mock.module("../../src/hooks/useContextMenu", () => ({
  useContextMenu: () => ({ handler() {}, isTarget: () => false }),
}))
mock.module("../../src/hooks/useTrackDrag", () => ({
  useTrackDrag: () => ({}),
}))
mock.module("../../src/hooks/useCapability", () => ({
  useCapability: () => false,
}))
mock.module("../../src/hooks/useMediaImage", () => ({
  useArtistImage: () => "https://image.test/poster.jpg",
  useArtistBackground: () => null,
  useAlbumImage: () => "https://image.test/poster.jpg",
  useAlbumBackground: () => null,
}))
mock.module("../../src/hooks/useMetadataEnrichment", () => ({
  useArtistEnrichment: () => ({}),
  useAlbumEnrichment: () => ({}),
}))
mock.module("../../src/hooks/useMetadataSnapshot", () => ({
  useMetadataSnapshot: () => ({
    sourceFields: () => null,
    resolveField: (field: string) =>
      ["summary", "biography"].includes(field)
        ? {
            value:
              "An expanded description that stays open while metadata updates.",
          }
        : undefined,
  }),
}))
mock.module("../../src/lib/focalPoint", () => ({
  useFocalPoint: () => "center",
}))
mock.module("../../src/stores/metadataSourceStore", () => ({
  useMetadataSourceStore: create(() => ({ priority: ["plex"] })),
}))
mock.module("../../src/stores/debugStore", () => ({
  useDebugStore: create(() => ({ debugEnabled: false })),
}))
mock.module("../../src/stores/debugPanelStore", () => ({
  useDebugPanelStore: create(() => ({ show() {} })),
}))
mock.module("../../src/components/MediaCard", () => ({ MediaCard: () => null }))
mock.module("../../src/components/ScrollRow", () => ({ ScrollRow: () => null }))
mock.module("../../src/components/VersionReview/VersionReviewPanel", () => ({
  VersionReviewPanel: () => null,
}))
for (const [path, name] of [
  ["../../src/components/shared/ArtworkSourcePicker", "ArtworkSourcePicker"],
  ["../../src/components/shared/DownloadBadge", "DownloadBadge"],
  ["../../src/components/shared/DownloadMenuItems", "DownloadMenuItems"],
  ["../../src/components/HeroRating", "HeroRating"],
  ["../../src/components/shared/StarRating", "StarRating"],
])
  mock.module(path!, () => ({ [name!]: () => null }))
mock.module("../../src/components/shared/MediaBackdrop", () => ({
  MediaBackdrop: () => null,
  AmbientHeroBackdrop: () => null,
}))
mock.module("../../src/components/shared/ImageModal", () => ({
  ImageModal: () => <div role="dialog">Artwork open</div>,
}))
mock.module("../../src/components/shared/MetadataEditDialog", () => ({
  MetadataEditDialog: () => <div role="dialog">Editor open</div>,
}))

const { useProviderStore } = await import("../../src/stores/providerStore")
const provider = {
  cacheScope: "test-scope",
  playbackSession: {},
  capabilities: {},
} as any
useProviderStore.getState().setProvider(provider)
const entry = (id: string, title = `Saved ${kind}`): any =>
  kind === "artist"
    ? {
        artist: { id, type: "artist", title, genres: [] },
        albums: [],
        singles: [],
        popularTracks: [],
        similarArtists: [],
        sonicallySimilar: [],
        relatedHubs: [],
        stations: [],
      }
    : {
        album: {
          id,
          type: "album",
          title,
          artistName: "Artist",
          genres: [],
          styles: [],
          moods: [],
          labels: [],
          trackCount: 0,
        },
        tracks: [],
        relatedHubs: [],
      }
let cached: any = entry("8")
const reads: ReturnType<typeof deferred<any>>[] = []
const forced: boolean[] = []
function load(_id: string, options: { force: boolean }) {
  forced.push(options.force)
  const reply = deferred<any>()
  reads.push(reply)
  return reply.promise
}
mock.module("../../src/stores/metadataCache", () => ({
  getCachedArtist: () => cached,
  getCachedAlbum: () => cached,
  loadArtistPage: load,
  loadAlbumPage: load,
  captureMetadataCache: () => provider,
  isMetadataCacheCurrent: (session: any) =>
    session === useProviderStore.getState().provider,
  prefetchArtist() {},
  prefetchAlbum() {},
}))
const { ArtistPage } = await import("../../src/components/Pages/Artist")
const { AlbumPage } = await import("../../src/components/Pages/Album")
const root = createRoot(document.getElementById("root")!)
const render = (id: string) =>
  kind === "artist" ? <ArtistPage artistId={id} /> : <AlbumPage albumId={id} />
const click = async (button: HTMLElement) =>
  act(async () => {
    button.click()
    await settle()
  })
try {
  await act(async () => {
    root.render(render("8"))
    await settle()
  })
  assert.equal(reads.length, 1)
  assert.equal(forced[0], false, "navigation must share fresh cache and prefetch reads")
  const more = [...document.querySelectorAll<HTMLElement>("[title]")].find(
    (el) => el.title === "Expand"
  )!
  // Album descriptions use an unlabelled click target; both pages expose More.
  const description =
    more ??
    [...document.querySelectorAll("span")].find(
      (el) => el.textContent?.trim() === "More"
    )!.parentElement!
  await click(description)
  assert(document.body.textContent!.includes("Less"))
  const artwork = document.querySelector<HTMLButtonElement>(
    'button[aria-label^="View "]'
  )!
  await click(artwork)
  assert.equal(document.querySelectorAll("[role=dialog]").length, 1)
  // Hover/prefetch can evict the currently visible entry from the bounded cache.
  cached = undefined
  await act(async () => {
    ui.setState({ pageRefreshKey: 1 })
    await settle()
  })
  assert.equal(reads.length, 2)
  assert.equal(forced[1], true, "an explicit refresh must request fresh server data")
  assert(
    document.body.textContent!.includes(`Saved ${kind}`),
    "visible data survives an evicted-cache refresh"
  )
  assert(
    document.body.textContent!.includes("Less"),
    "description remains expanded"
  )
  assert.equal(
    document.querySelectorAll("[role=dialog]").length,
    1,
    "artwork remains open"
  )
  await act(async () => {
    reads[0]!.resolve(entry("8", "Stale response"))
    await settle()
  })
  assert(!document.body.textContent!.includes("Stale response"))
  await act(async () => {
    reads[1]!.resolve(entry("8", "Fresh response"))
    await settle()
  })
  assert(document.body.textContent!.includes("Fresh response"))
  assert(document.body.textContent!.includes("Less"))
  assert.equal(document.querySelectorAll("[role=dialog]").length, 1)
  // The edit dialog must also survive a genuine same-page metadata revision.
  await act(async () => {
    root.render(render("9"))
    await settle()
  })
  assert.equal(
    document.querySelectorAll("[role=dialog]").length,
    0,
    "navigation closes the previous entity's artwork"
  )
  assert(
    !document.body.textContent!.includes("Fresh response"),
    "navigation never leaks stale entity data"
  )
  await act(async () => {
    reads[2]!.resolve(entry("9"))
    await settle()
  })
  await click(document.querySelector<HTMLElement>('[title="More options"]')!)
  await click(
    [...document.querySelectorAll("button")].find((el) =>
      el.textContent?.includes("Edit metadata and sources")
    )!
  )
  assert(document.body.textContent!.includes("Editor open"))
  await act(async () => {
    ui.setState({ pageRefreshKey: 2 })
    await settle()
  })
  assert(
    document.body.textContent!.includes("Editor open"),
    "metadata updates preserve unsaved editing"
  )
} finally {
  await act(async () => root.unmount())
  dom.window.close()
}
