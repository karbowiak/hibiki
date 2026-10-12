import { mock } from "bun:test"
import assert from "node:assert/strict"
import { create } from "zustand"
import { PreferencePersistence } from "../../src/stores/preferencePersistence"
import { persistenceMiddleware } from "../../src/stores/safePersist"
let hydrate!: (value: any) => void
let stored: any
const persistence = new PreferencePersistence({
  get: () => new Promise((resolve) => (hydrate = resolve)),
  update: async (_, transform) => {
    stored = transform(stored)
  },
  remove: async () => {
    stored = undefined
  },
})
mock.module("../../src/stores/idbStorage", () => ({
  safePersist: persistenceMiddleware(persistence),
}))
const status = (revision: string, enabled = true) => ({
  revision,
  baseUrl: "https://synthetic.test",
  enabled,
  configured: true,
  hasApiKey: true,
})
const service = create(() => ({
  status: status("A"),
  loading: false,
  error: null,
  load: async () => {},
  configure: async () => true,
}))
mock.module("../../src/metadata/services/store", () => ({
  useFanartServiceStore: service,
  useHeyaServiceStore: service,
}))
const mbid = "12345678-1234-1234-1234-123456789abc"
mock.module("../../src/metadata/musicbrainz/store", () => ({
  useMusicBrainzMetadataStore: {
    getState: () => ({
      getArtist: async () => ({ name: "Artist", mbid, wikidata_url: null }),
      getAlbum: async () => ({
        artist: "Artist",
        title: "Album",
        mbid: "22345678-1234-1234-1234-123456789abc",
      }),
    }),
  },
}))
let oldResolve!: (value: any) => void,
  calls = 0
const art = (revision: string) => ({
  name: "Artist",
  mbid,
  revision,
  posters: [{ id: "portrait:1", url: `https://assets.fanart.tv/${revision}` }],
  backgrounds: [],
  albums: [],
})
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (command: string, args: any) => {
    if (command === "fanart_get_artist") {
      calls++
      return calls === 1
        ? new Promise((resolve) => (oldResolve = resolve))
        : art(args.revision)
    }
    throw new Error("Unexpected synthetic command")
  },
}))
const { useFanartMetadataStore: store } =
  await import("../../src/metadata/fanart/store")
const settle = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve()
}
await settle()
const pending = store.getState().getArtist("Artist")
await settle()
assert.equal(calls, 1)
service.setState({ status: status("B") })
oldResolve(art("A"))
assert.equal(await pending, null)
hydrate({
  state: {
    artists: { artist: { data: art("A"), cachedAt: Date.now() } },
    albums: {},
  },
  version: 0,
})
await settle()
const fresh = await store.getState().getArtist("Artist")
assert.equal(fresh?.revision, "B")
assert.equal(store.getState().artists.artist.data?.revision, "B")
// Even a late stale positive directly entering the cache cannot bypass the validator.
store.setState({
  artists: { artist: { data: art("A"), cachedAt: Date.now() } },
})
assert.equal((await store.getState().getArtist("Artist"))?.revision, "B")
const before = calls
service.setState({ status: status("B", false) })
assert.equal(await store.getState().getArtist("Artist"), null)
assert.equal(calls, before)
assert.equal(JSON.stringify(service.getState()).includes("apiKey"), false)
