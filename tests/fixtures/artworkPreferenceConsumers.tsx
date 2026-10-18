import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import { deferred } from "../helpers/radioAudioFakes"
const scenario = process.argv[2]!
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://synthetic.test",
})
globalThis.document = dom.window.document
globalThis.window = dom.window as any
globalThis.localStorage = dom.window.localStorage
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { useMetadataIdentityStore } =
  await import("../../src/stores/metadataIdentityStore")
useMetadataIdentityStore.setState({ choices: {}, versions: {}, hydrated: true })
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const timers = new Map<number, () => void>()
let nextTimer = 0
const timeout = globalThis.setTimeout,
  clear = globalThis.clearTimeout
globalThis.setTimeout = ((callback: () => void) => {
  timers.set(++nextTimer, callback)
  return nextTimer
}) as any
globalThis.clearTimeout = ((id: number) => timers.delete(id)) as any
const requests: string[] = []
const deezer = create(() => ({
  artists: {} as Record<string, any>,
  albums: {},
  _hasHydrated: true,
  getArtist: async (name: string) => {
    requests.push(name)
    return null
  },
  getAlbum: async () => null,
}))
const priority = create(() => ({ priority: ["plex", "deezer"] as string[] }))
const player = create(() => ({ playerError: null as string | null }))
let selection = 0
mock.module("../../src/metadata/deezer/store", () => ({
  useDeezerMetadataStore: deezer,
}))
mock.module("../../src/metadata/apple/store", () => ({
  useItunesMetadataStore: create(() => ({
    albums: {},
    _hasHydrated: true,
    getAlbum: async () => null,
  })),
}))
mock.module("../../src/stores/metadataSourceStore", () => ({
  useMetadataSourceStore: priority,
  SOURCE_LABELS: {
    plex: "Plex",
    deezer: "Deezer",
    lastfm: "Last.fm",
    apple: "Apple Music",
    musicbrainz: "MusicBrainz",
  },
}))
mock.module("../../src/stores/index", () => ({
  usePlayerStore: player,
  useUIStore: create(() => ({})),
  useLibraryStore: create(() => ({})),
}))
mock.module("../../src/stores/playerStore", () => ({
  usePlayerStore: player,
  prefetchTrackAudio() {},
  capturePlaybackSelectionVersion: () => selection,
}))
mock.module("../../src/stores/metadataCache", () => ({
  invalidateMetadataItem() {},
  expireMetadataItem() {},
  subscribeMetadataPages: () => () => {},
  getCachedArtist: () => null,
  getCachedAlbum: () => null,
  prefetchAlbum() {},
  prefetchArtist() {},
  loadArtistPage() {},
  loadAlbumPage() {},
  captureMetadataCache() {},
  isMetadataCacheCurrent() {},
}))
mock.module("../../src/hooks/useMetadataEnrichment", () => ({
  useArtistEnrichment: () => ({}),
}))
const artist = {
  id: "known-artist",
  title: "Artist",
  thumbUrl: "image://localhost/ext/img?scope=library-one&src=plex",
} as any
async function tick() {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}
try {
  if (scenario === "playback-notice") {
    const { useProviderStore } = await import("../../src/stores/providerStore")
    const { useAnnouncerStore } =
      await import("../../src/stores/announcerStore")
    const { makeOnPlay } = await import("../../src/lib/mediaPlay")
    const owner: any = { buildItemUri: () => "synthetic-uri" }
    useProviderStore.getState().setProvider(owner)
    const pending = deferred<void>()
    const store = {
      provider: owner,
      playTrack: async () => {},
      playPlaylist: async () => {},
      playFromUri: () => {
        selection++
        return pending.promise
      },
    }
    const action = makeOnPlay(
      { type: "album", id: "album", title: "Album" } as any,
      store
    )!
    await tick()
    action()
    pending.reject(new Error("private credentials"))
    await tick()
    assert.equal(
      player.getState().playerError,
      "Could not play Album. Please try again."
    )
    assert.equal(
      useAnnouncerStore.getState().assertiveMessage,
      "Could not play Album. Please try again."
    )
    assert.equal(timers.size, 1)
    const callback = [...timers.values()][0]!
    callback()
    assert.equal(player.getState().playerError, null)
  } else {
    const { useProviderStore } = await import("../../src/stores/providerStore")
    useProviderStore
      .getState()
      .setProvider({ cacheScope: "synthetic/library", capabilities: {} } as any)
    const { SimilarArtistAvatar } =
      await import("../../src/components/Pages/Artist")
    if (scenario === "disabled") {
      priority.setState({ priority: ["plex", "apple"] })
      deezer.setState({
        artists: {
          artist: { data: { image_url: "https://synthetic.test/disabled" } },
        },
      })
      await act(async () => root.render(<SimilarArtistAvatar name="Artist" />))
      assert.equal(document.querySelector("img"), null)
      assert.deepEqual(requests, [])
      assert.equal(document.getElementById("root")!.textContent, "A")
    } else {
      if (scenario === "deezer-first")
        priority.setState({ priority: ["deezer", "plex"] })
      if (scenario === "failed-plex" || scenario === "entity-switch")
        deezer.setState({
          artists: {
            artist: { data: { image_url: "https://synthetic.test/deezer" } },
          },
        })
      await act(async () =>
        root.render(<SimilarArtistAvatar name="Artist" artist={artist} />)
      )
      assert.equal(
        document.querySelector("img")!.getAttribute("src"),
        artist.thumbUrl
      )
      assert.equal(
        document.querySelector("img")!.getAttribute("loading"),
        "lazy"
      )
      if (scenario === "plex-first") assert.deepEqual(requests, [])
      else if (scenario === "deezer-first") {
        assert.deepEqual(requests, ["Artist"])
        await act(async () =>
          deezer.setState({
            artists: {
              artist: { data: { image_url: "https://synthetic.test/deezer" } },
            },
          })
        )
        assert.ok(
          document
            .querySelector("img")!
            .getAttribute("src")
            ?.includes("synthetic.test%2Fdeezer")
        )
      } else {
        for (let attempt = 0; attempt < 3; attempt++) {
          await act(async () =>
            document
              .querySelector("img")!
              .dispatchEvent(new dom.window.Event("error"))
          )
          if (attempt < 2) {
            const [id, callback] = [...timers][0]!
            timers.delete(id)
            await act(async () => callback())
          }
        }
        assert.ok(
          document
            .querySelector("img")!
            .getAttribute("src")
            ?.includes("synthetic.test%2Fdeezer")
        )
        if (scenario === "entity-switch") {
          const replacement = {
            ...artist,
            id: "replacement",
            title: "Other",
            thumbUrl: "image://localhost/ext/img?scope=library-two&src=plex",
          }
          await act(async () =>
            root.render(
              <SimilarArtistAvatar name="Other" artist={replacement} />
            )
          )
          assert.equal(
            document.querySelector("img")!.getAttribute("src"),
            replacement.thumbUrl
          )
          assert.deepEqual(requests, [])
        }
      }
    }
  }
} finally {
  await act(async () => root.unmount())
  globalThis.setTimeout = timeout
  globalThis.clearTimeout = clear
  dom.window.close()
}
