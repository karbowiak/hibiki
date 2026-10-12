import { expect, test } from "bun:test"
import { createHeyaArtworkStore } from "../src/metadata/heya/artworkStore"
import { useHeyaServiceStore } from "../src/metadata/services/store"
import { useMusicBrainzMetadataStore } from "../src/metadata/musicbrainz/store"
import { deferred, settle } from "./helpers/radioAudioFakes"
const revision = "22222222-2222-4222-8222-222222222222",
  nextRevision = "33333333-3333-4333-8333-333333333333",
  imageId = "11111111-1111-4111-8111-111111111111"
const status = (revision: string) => ({
  revision,
  baseUrl: "https://private.synthetic.test",
  configured: true,
  enabled: true,
  hasApiKey: true,
})
function item(artist = "Artist", title: string | null = null) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    artist,
    title,
    revision,
    posters: [
      {
        id: imageId,
        url: `heyametadata://image/${imageId}?serviceRevision=${revision}`,
        label: "Provider · profile",
      },
    ],
    backgrounds: [],
  }
}
test("Heya artwork requires configured verified detail each fresh store and caches no raw service URLs", async () => {
  const original = useHeyaServiceStore.getState(),
    mb = useMusicBrainzMetadataStore.getState()
  let calls = 0
  try {
    useHeyaServiceStore.setState({ status: null })
    useMusicBrainzMetadataStore.setState({
      getArtist: async () => null,
      getAlbum: async () => null,
    })
    const store = createHeyaArtworkStore(async () => {
      calls++
      return { status: "ready", item: item() }
    })
    expect(await store.getState().getArtist("Artist")).toBeNull()
    expect(calls).toBe(0)
    useHeyaServiceStore.setState({ status: status(revision) })
    expect((await store.getState().getArtist("Artist"))?.posters[0].id).toBe(
      imageId
    )
    await store.getState().getArtist("Artist")
    expect(calls).toBe(1)
    const fresh = createHeyaArtworkStore(async () => {
      calls++
      return { status: "ready", item: item() }
    })
    await fresh.getState().getArtist("Artist")
    expect(calls).toBe(2)
    store.getState().invalidateArtist("Artist")
    await store.getState().getArtist("Artist")
    expect(calls).toBe(3)
  } finally {
    useHeyaServiceStore.setState(original)
    useMusicBrainzMetadataStore.setState(mb)
  }
})
test("Heya artwork rejects mismatches and configuration-retired detail before publishing", async () => {
  const original = useHeyaServiceStore.getState(),
    mb = useMusicBrainzMetadataStore.getState()
  const response = deferred<any>()
  try {
    useMusicBrainzMetadataStore.setState({
      getArtist: async () => null,
      getAlbum: async () => null,
    })
    useHeyaServiceStore.setState({ status: status(revision) })
    const store = createHeyaArtworkStore(() => response.promise)
    const pending = store.getState().getAlbum("Artist", "Album")
    await settle()
    useHeyaServiceStore.setState({ status: status(nextRevision) })
    response.resolve({ status: "ready", item: item("Artist", "Album") })
    expect(await pending).toBeNull()
    expect(store.getState().albums).toEqual({})
    const mismatch = createHeyaArtworkStore(async () => ({
      status: "ready",
      item: { ...item("Other", "Album"), revision: nextRevision },
    }))
    expect(await mismatch.getState().getAlbum("Artist", "Album")).toBeNull()
  } finally {
    useHeyaServiceStore.setState(original)
    useMusicBrainzMetadataStore.setState(mb)
  }
})
test("Heya artwork coalesces pending detail and invalidation retires only that lookup", async () => {
  const original = useHeyaServiceStore.getState(),
    mb = useMusicBrainzMetadataStore.getState()
  const response = deferred<any>()
  let calls = 0
  try {
    useMusicBrainzMetadataStore.setState({
      getArtist: async () => null,
      getAlbum: async () => null,
    })
    useHeyaServiceStore.setState({ status: status(revision) })
    const store = createHeyaArtworkStore(() => {
      calls++
      return response.promise
    })
    const first = store.getState().getArtist("Artist"),
      second = store.getState().getArtist("Artist")
    await settle()
    expect(calls).toBe(1)
    store.getState().invalidateArtist("Artist")
    expect(store.getState()._loadingArtists).toEqual({})
    response.resolve({ status: "ready", item: item() })
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(store.getState().artists).toEqual({})
  } finally {
    useHeyaServiceStore.setState(original)
    useMusicBrainzMetadataStore.setState(mb)
  }
})

test("Heya artwork bounds memory and concurrent lookups without caching rejected admission", async () => {
  const original = useHeyaServiceStore.getState(),
    mb = useMusicBrainzMetadataStore.getState()
  try {
    useMusicBrainzMetadataStore.setState({
      getArtist: async () => null,
      getAlbum: async () => null,
    })
    useHeyaServiceStore.setState({ status: status(revision) })
    const cache = createHeyaArtworkStore(async (args) => ({
      status: "ready",
      item: item(args.artist, args.title),
    }))
    for (let i = 0; i < 80; i++) await cache.getState().getArtist(`Artist ${i}`)
    expect(Object.keys(cache.getState().artists)).toHaveLength(32)
    const gate = deferred<any>()
    let calls = 0
    const store = createHeyaArtworkStore(async () => {
      calls++
      return gate.promise
    })
    const work = Array.from({ length: 32 }, (_, i) =>
      store.getState().getArtist(`Artist ${i}`)
    )
    await settle()
    expect(calls).toBe(32)
    expect(await store.getState().getArtist("Overflow")).toBeNull()
    expect(store.getState().artists.overflow).toBeUndefined()
    gate.resolve({ status: "unavailable" })
    await Promise.all(work)
    expect(Object.keys(store.getState()._loadingArtists)).toHaveLength(0)
  } finally {
    useHeyaServiceStore.setState(original)
    useMusicBrainzMetadataStore.setState(mb)
  }
})
