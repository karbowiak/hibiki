import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import { deferred } from "../helpers/radioAudioFakes"
const [kind, scenario] = process.argv.slice(2)
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
globalThis.window = dom.window as any
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const navigation: string[] = [],
  played: any[][] = []
mock.module("wouter", () => ({
  useLocation: () => ["/", (path: string) => navigation.push(path)],
  Link: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))
const ui = create(() => ({ pageRefreshKey: 0, deduplicateAlbums: false }))
mock.module("../../src/stores/uiStore", () => ({ useUIStore: ui }))
const player = create(() => ({
  currentTrack: null,
  playTrack: (...args: any[]) => {
    played.push(args)
    return Promise.resolve()
  },
  playFromUri: (...args: any[]) => {
    played.push(args)
    return Promise.resolve()
  },
  playRadio() {},
  addToQueue() {},
  addNext() {},
}))
const library = create(() => ({ tagsGenre: [], tagsMood: [], tagsStyle: [] }))
mock.module("../../src/stores", () => ({
  useUIStore: ui,
  usePlayerStore: player,
  useLibraryStore: library,
}))
mock.module("../../src/stores/playerStore", () => ({ usePlayerStore: player, prefetchTrackAudio() {} }))
mock.module("../../src/hooks/useMediaImage", () => ({
  useArtistImage: () => null,
  useAlbumImage: () => null,
  useArtistBackground: () => null,
  useAlbumBackground: () => null,
}))
mock.module("../../src/hooks/useMetadataEnrichment", () => ({
  useArtistEnrichment: () => ({}),
  useAlbumEnrichment: () => ({}),
}))
mock.module("../../src/hooks/useContextMenu", () => ({
  useContextMenu: () => ({ handler: () => () => {}, isTarget: () => false }),
}))
mock.module("../../src/hooks/useTrackDrag", () => ({
  useTrackDrag: () => ({}),
}))
mock.module("../../src/hooks/useCapability", () => ({
  useCapability: () => false,
}))
mock.module("../../src/lib/focalPoint", () => ({
  useFocalPoint: () => "center",
}))
mock.module("../../src/components/shared/ArtworkImage", () => ({
  ArtworkImage: () => null,
  useArtworkFailures: () => ({ failures: [], onFailure() {} }),
}))
mock.module("../../src/components/shared/ArtworkSourcePicker", () => ({
  ArtworkSourcePicker: () => null,
  ArtworkSourcePanel: () => null,
}))
mock.module("../../src/components/UltraBlur", () => ({ UltraBlur: () => null }))
mock.module("../../src/components/shared/MediaBackdrop", () => ({
  MediaBackdrop: () => null,
  AmbientHeroBackdrop: () => null,
}))
mock.module("../../src/hooks/useArtworkTone", () => ({
  useArtworkTone: () => undefined,
}))
mock.module("../../src/components/HeroRating", () => ({
  HeroRating: () => null,
}))
mock.module("../../src/components/shared/StarRating", () => ({
  StarRating: () => null,
}))
mock.module("../../src/components/MediaCard", () => ({
  MediaCard: ({ title }: any) => <span>{title}</span>,
}))
mock.module("../../src/components/ScrollRow", () => ({
  ScrollRow: ({ title, children }: any) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const owner = (scope: string) => ({
  cacheScope: scope,
  capabilities: {},
  buildItemUri: (id: string) => `fixture:${id}`,
})
const original = owner("first")
if (scenario !== "disconnected")
  useProviderStore.getState().setProvider(original as any)
const pending: Array<{
  id: string
  owner: any
  reply: ReturnType<typeof deferred<any>>
}> = []
const cache = new Map<string, any>()
const cacheKey = (id: string) =>
  `${useProviderStore.getState().provider?.cacheScope}:${id}`
const load = (id: string) => {
  const reply = deferred<any>()
  pending.push({ id, owner: useProviderStore.getState().provider, reply })
  return reply.promise
}
mock.module("../../src/stores/metadataCache", () => ({
  invalidateMetadataItem() {},
  expireMetadataItem() {},
  subscribeMetadataPages: () => () => {},
  getCachedArtist: (id: string) => cache.get(cacheKey(id)),
  getCachedAlbum: (id: string) => cache.get(cacheKey(id)),
  loadArtistPage: load,
  loadAlbumPage: load,
  captureMetadataCache: (provider: any) => provider,
  isMetadataCacheCurrent: (provider: any) =>
    useProviderStore.getState().provider === provider,
  prefetchArtist() {},
  prefetchAlbum() {},
}))
const { ArtistPage } = await import("../../src/components/Pages/Artist")
const { AlbumPage } = await import("../../src/components/Pages/Album")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const track = {
  id: "track",
  title: "Fixture track",
  artistName: "Fixture artist",
  duration: 1000,
  userRating: 0,
}
const entry = (name: string, id: string) =>
  kind === "artist"
    ? {
        artist: { id, title: name, genres: [], styles: [], moods: [] },
        albums: [],
        singles: [],
        popularTracks: [track],
        similarArtists: [],
        sonicallySimilar: [],
        relatedHubs: [],
        stations: [],
      }
    : {
        album: {
          id,
          title: name,
          artistName: "Fixture artist",
          labels: [],
          genres: [],
          styles: [],
          moods: [],
          userRating: 0,
        },
        tracks: [track],
        relatedHubs: [],
      }
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
async function render(id = "one") {
  await act(async () => {
    root.render(
      kind === "artist" ? (
        <ArtistPage artistId={id} />
      ) : (
        <AlbumPage albumId={id} />
      )
    )
    await flush()
  })
}
async function settle(index: number, name: string, fail = false) {
  await act(async () => {
    const request = pending[index]
    if (fail)
      request.reply.reject(
        new Error("https://private.test?token=private-placeholder")
      )
    else {
      const result = entry(name, request.id)
      if (request.owner === useProviderStore.getState().provider)
        cache.set(cacheKey(request.id), result)
      request.reply.resolve(result)
    }
    await flush()
  })
}
async function retry() {
  const button = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again"
  )!
  assert(button)
  await act(async () => {
    button.click()
    await flush()
  })
}
await render()
if (scenario === "disconnected") {
  assert.equal(pending.length, 0)
  assert.match(document.body.textContent!, /Connect your music library/)
  const button = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Open Settings"
  )!
  await act(async () => button.click())
  assert.deepEqual(navigation, ["/settings"])
} else if (scenario === "route") {
  await render("two")
  await settle(1, "Current")
  await settle(0, "Obsolete", true)
  assert(document.body.textContent!.includes("Current"))
  assert(!document.body.textContent!.includes("private-placeholder"))
  assert.equal(document.querySelector('[role="alert"]'), null)
} else if (scenario === "provider") {
  await act(async () =>
    useProviderStore.getState().setProvider(owner("second") as any)
  )
  await settle(1, "Current")
  await settle(0, "Obsolete")
  assert(document.body.textContent!.includes("Current"))
  assert(!document.body.textContent!.includes("Obsolete"))
} else {
  await settle(0, "", true)
  assert(document.querySelector('[role="alert"]'))
  assert(!document.body.textContent!.includes("private-placeholder"))
  await retry()
  await settle(1, "Recovered")
  assert(document.body.textContent!.includes("Recovered"))
  assert.equal(document.querySelector('[role="alert"]'), null)
  const play = [...document.querySelectorAll("button")].find((button) =>
    (button.getAttribute("aria-label") ?? button.title).startsWith("Play")
  )!
  assert(play)
  assert.equal(play.disabled, false)
  await act(async () => {
    play.click()
    await flush()
  })
  assert.equal(played.length, 1)
  if (kind === "album") {
    assert.equal(played[0][0], track)
    assert.equal(played[0][4], "one")
  } else assert.equal(played[0][0], "fixture:/library/metadata/one")
  await act(async () => ui.setState({ pageRefreshKey: 1 }))
  assert(document.body.textContent!.includes("Recovered"))
  await settle(2, "", true)
  assert(document.body.textContent!.includes("Recovered"))
  assert.match(document.body.textContent!, /Couldn't refresh this/)
  assert(!document.body.textContent!.includes("private-placeholder"))
}
await act(async () => root.unmount())
