import { expect, test } from "bun:test"
import { createMetadataStore } from "../src/stores/createMetadataStore"
import { deferred } from "./helpers/radioAudioFakes"
test("targeted metadata refresh retires old requests without clearing unrelated entries or newer in-flight work", async () => {
  const old = deferred<any>(),
    fresh = deferred<any>()
  let calls = 0
  const store = createMetadataStore({
    storeName: "synthetic-artwork-refresh",
    fetchArtist: async () => (++calls === 1 ? old.promise : fresh.promise),
    fetchAlbum: async () => null,
  })
  store.setState({
    artists: { other: { data: { image_url: "other" }, cachedAt: Date.now() } },
  })
  const first = store.getState().getArtist("Artist")
  store.getState().invalidateArtist("Artist")
  const second = store.getState().getArtist("Artist")
  old.resolve({ image_url: "old" })
  expect(await first).toBeNull()
  const shared = store.getState().getArtist("Artist")
  expect(calls).toBe(2)
  expect(store.getState()._loadingArtists.artist).toBe(true)
  fresh.resolve({ image_url: "new" })
  await second
  await shared
  expect(store.getState().artists.artist.data.image_url).toBe("new")
  expect(store.getState()._loadingArtists.artist).toBeUndefined()
  expect(store.getState().artists.other.data.image_url).toBe("other")
})
test("album refresh keeps strict matching and an old request cannot republish after invalidation", async () => {
  const old = deferred<any>()
  let calls = 0
  const store = createMetadataStore({
    storeName: "synthetic-album-refresh",
    fetchArtist: async () => null,
    fetchAlbum: async () =>
      ++calls === 1 ? old.promise : { title: "Unrelated" },
    validateAlbum: (data, _, title) => data.title === title,
  })
  const first = store.getState().getAlbum("Artist", "Album")
  store.getState().invalidateAlbum("Artist", "Album")
  expect(await store.getState().getAlbum("Artist", "Album")).toBeNull()
  old.resolve({ title: "Album" })
  expect(await first).toBeNull()
  expect(store.getState().albums["artist::album"]).toBeUndefined()
})

test("failed lookup stops its loading status and remains retryable without a false negative cache", async () => {
  let attempts = 0
  const store = createMetadataStore({
    storeName: "synthetic-artwork-failure",
    fetchArtist: async () => {
      attempts++
      throw new Error("Synthetic failure")
    },
    fetchAlbum: async () => null,
  })
  expect(await store.getState().getArtist("Artist")).toBeNull()
  expect(store.getState()._loadingArtists.artist).toBeUndefined()
  expect(store.getState().artists.artist).toBeUndefined()
  await store.getState().getArtist("Artist")
  expect(attempts).toBe(2)
})
