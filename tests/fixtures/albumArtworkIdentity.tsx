import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
const scenario = process.argv[2]
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
globalThis.window = dom.window as any
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const correct = {
  artist: "Yoshiko",
  title: "Bumble Bee - Single",
  cover_url: "https://covers.test/correct.jpg",
  label: "Correct label",
  genres: ["Electronic"],
  fans: 42,
  track_count: 1,
}
const other = { ...correct, title: "Actual Other Album" }
const wrongArtist = {
  ...correct,
  artist: "Various Artists",
  title: "100 Silly Sing Along Songs for Kids",
  cover_url: "https://covers.test/unrelated.jpg",
}
const entry = (data: any) => ({ data, cachedAt: Date.now() })
const albums = {
  "yoshiko::bumble bee": entry(wrongArtist),
  "yoshiko::greed": entry({ ...correct, artist: "Godsmack", title: "Greed" }),
  "yoshiko::body rock": entry({
    ...correct,
    artist: "Justin Bieber",
    title: "Body Rock",
  }),
  "yoshiko::wrong title": entry({ ...correct, title: "Different Album" }),
  "yoshiko::actual other album": entry(other),
  "yoshiko::negative": entry(null),
}
const artists = {
  yoshiko: entry({
    name: "Yoshiko",
    image_url: "https://covers.test/artist.jpg",
  }),
}
const values = new Map<string, string>()
if (scenario === "hydration")
  for (const key of ["deezer-metadata-v1", "itunes-metadata-v2"])
    values.set(key, JSON.stringify({ state: { artists, albums }, version: 0 }))
const applicationStorage = await import("../../src/storage/clientStorage")
mock.module("../../src/storage/clientStorage", () => ({ ...applicationStorage,
  get: async (key: string) => values.get(key),
  update: async (key: string, transform: (value: unknown) => string) => {
    values.set(key, transform(values.get(key)))
  },
  set: async (key: string, value: string) => {
    values.set(key, value)
  },
  del: async (key: string) => {
    values.delete(key)
  },
}))
const calls: string[] = []
let notFound = false
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  convertFileSrc: (src: string) => src,
  invoke: async (command: string, args: any) => {
    calls.push(`${command}:${args.artist}:${args.album}`)
    return notFound ? null : scenario === "getter" ? wrongArtist : correct
  },
}))
const priority = create(() => ({
  priority: ["deezer", "apple", "plex"] as string[],
}))
mock.module("../../src/stores/metadataSourceStore", () => ({
  useMetadataSourceStore: priority,
}))
const { useDeezerMetadataStore } =
  await import("../../src/metadata/deezer/store")
const { useItunesMetadataStore } =
  await import("../../src/metadata/apple/store")
async function flush() {
  for (let i = 0; i < 70; i++) await Promise.resolve()
}
await flush()
for (const store of [useDeezerMetadataStore, useItunesMetadataStore])
  assert.equal(store.getState()._hasHydrated, true)
if (scenario === "hydration") {
  for (const store of [useDeezerMetadataStore, useItunesMetadataStore]) {
    assert.deepEqual(Object.keys(store.getState().albums).sort(), [
      "yoshiko::actual other album",
      "yoshiko::negative",
    ])
    assert.deepEqual(
      store.getState().albums["yoshiko::actual other album"].data,
      other
    )
    assert.deepEqual(store.getState().artists, artists)
  }
  assert.equal(calls.length, 0)
  await flush()
  for (const key of ["deezer-metadata-v1", "itunes-metadata-v2"]) {
    assert.deepEqual(
      Object.keys(JSON.parse(values.get(key)!).state.albums).sort(),
      ["yoshiko::actual other album", "yoshiko::negative"]
    )
  }
} else if (scenario === "getter") {
  useDeezerMetadataStore.setState({ albums })
  const [first, second] = await Promise.all([
    useDeezerMetadataStore.getState().getAlbum("Yoshiko", "Bumble Bee"),
    useDeezerMetadataStore.getState().getAlbum("Yoshiko", "Bumble Bee"),
  ])
  assert.equal(first, null)
  assert.equal(second, null)
  assert.equal(calls.length, 1)
  assert.equal(
    useDeezerMetadataStore.getState().albums["yoshiko::bumble bee"],
    undefined
  )
  assert.deepEqual(
    useDeezerMetadataStore.getState().albums["yoshiko::actual other album"]
      .data,
    other
  )
  notFound = true
  assert.equal(
    await useDeezerMetadataStore.getState().getAlbum("Yoshiko", "Bumble Bee"),
    null
  )
  assert.equal(calls.length, 2)
  assert.equal(
    useDeezerMetadataStore.getState().albums["yoshiko::bumble bee"].data,
    null
  )
  assert.equal(
    await useDeezerMetadataStore.getState().getAlbum("Yoshiko", "Bumble Bee"),
    null
  )
  assert.equal(calls.length, 2)
  useItunesMetadataStore.setState({
    albums: { "yoshiko::bumble bee": entry(correct) },
  })
  assert.deepEqual(
    await useItunesMetadataStore.getState().getAlbum("Yoshiko", "Bumble Bee"),
    correct
  )
  assert.equal(calls.length, 2)
} else {
  useDeezerMetadataStore.setState({
    albums: { "yoshiko::bumble bee": entry(wrongArtist) },
  })
  useItunesMetadataStore.setState({
    albums: {
      "yoshiko::bumble bee": entry({
        ...wrongArtist,
        artist: "Yoshiko",
        title: "Other Album",
      }),
    },
  })
  const { createRoot } = await import("react-dom/client")
  const { useMetadataIdentityStore } =
    await import("../../src/stores/metadataIdentityStore")
  useMetadataIdentityStore.setState({
    choices: {},
    versions: {},
    hydrated: true,
  })
  const { useProviderStore } = await import("../../src/stores/providerStore")
  useProviderStore
    .getState()
    .setProvider({ cacheScope: "synthetic/library", capabilities: {} } as any)
  const { useAlbumImage } = await import("../../src/hooks/useMediaImage")
  const plex =
    "image://localhost/album/845010?src=https%3A%2F%2Fplex.test%2Fthumb"
  const seen: (string | null)[] = []
  function AlbumCover() {
    const image = useAlbumImage("Yoshiko", "Bumble Bee", plex, "845010")
    seen.push(image)
    return <div data-url={image ?? ""} />
  }
  const root = createRoot(document.getElementById("root")!)
  await act(async () => {
    root.render(<AlbumCover />)
    await flush()
  })
  assert.ok(seen.every((image) => !image?.includes("unrelated")))
  assert.equal(seen[0], plex)
  assert.ok(seen.at(-1)?.includes("correct.jpg"))
  await act(async () => {
    priority.setState({ priority: ["plex", "deezer", "apple"] })
    await flush()
  })
  assert.equal(seen.at(-1), plex)
  await act(async () => root.unmount())
}
await flush()
dom.window.close()
