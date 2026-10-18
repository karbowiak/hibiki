import { expect, mock, test } from "bun:test"
import { createStore } from "zustand/vanilla"

const provider = createStore(() => ({ provider: null as any }))
const youtube = createStore(() => ({
  connected: false,
  revision: 0,
  accountId: null,
}))
const auth = createStore(() => ({
  isAuthenticated: false,
  isEnabled: false,
  username: null,
}))
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async () => null,
}))
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }))
mock.module("../../src/stores/providerStore", () => ({
  useProviderStore: provider,
}))
mock.module("../../src/backends/ytmusic/discovery", () => ({
  useYoutubeMusicDiscoveryStore: youtube,
}))
mock.module("../../src/metadata/lastfm/authStore", () => ({
  useLastfmStore: auth,
}))
mock.module("../../src/metadata/listenbrainz/authStore", () => ({
  useListenBrainzStore: auth,
}))
mock.module("../../src/stores/libraryStore", () => ({
  useLibraryStore: createStore(() => ({})),
}))
mock.module("../../src/offline/collectionCache", () => ({
  collectionBackgroundProvider: (value: any) => value,
}))
mock.module("../../src/offline/providerCache", () => ({
  backgroundMetadataRead: () => true,
  freshPlaylistReads: (value: any) => value,
}))

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: any) => any) | null = null
  onerror: any
  onmessageerror: any
  messages: any[] = []
  terminated = false
  constructor(..._args: any[]) {
    FakeWorker.instances.push(this)
  }
  postMessage(message: any) {
    this.messages.push(structuredClone(message))
  }
  terminate() {
    this.terminated = true
  }
  receive(data: any) {
    const event = { data, currentTarget: this as FakeWorker | null }
    const result = this.onmessage!(event)
    // Browsers clear currentTarget as soon as the synchronous dispatch returns.
    event.currentTarget = null
    return result
  }
  get owner() {
    return this.messages.findLast((message) => message.type === "context")
      .context.owner
  }
}

test("asynchronous RPC survives DOM event cleanup and cannot reply into a replacement worker", async () => {
  const { backgroundDomains } = await import("../../src/background/actions")
  const { startBackgroundWorker } = await import("../../src/background/runtime")
  const originals = new Map(backgroundDomains)
  const mixed = createStore(() => ({
    playlists: [{ id: "one", revision: 1 }],
    running: false,
  }))
  backgroundDomains.set("mixed", { store: mixed, methods: {} })
  const originalWorker = globalThis.Worker
  globalThis.Worker = FakeWorker as any
  const pending: ((value: any) => void)[] = []
  const plex = {
    name: "Plex",
    cacheScope: "library",
    playbackSession: "first",
    capabilities: {},
    getArtist: () => new Promise((resolve) => pending.push(resolve)),
  }
  provider.setState({ provider: plex })
  const stop = startBackgroundWorker()
  try {
    const first = FakeWorker.instances[0]
    await first.receive({ type: "ready" })
    const rpc = (target: FakeWorker, id: number) =>
      target.receive({
        type: "rpc",
        kind: "provider",
        owner: target.owner,
        id,
        method: "getArtist",
        args: ["artist"],
      })
    const read = rpc(first, 1)
    pending.shift()!({ title: "Artist" })
    await read
    expect(
      first.messages.find((message) => message.type === "reply")
    ).toMatchObject({ id: 1, value: { title: "Artist" } })

    // Metadata-only updates send no unchanged collection and retain this worker.
    const initialStates = first.messages.filter(
      (message) => message.type === "state"
    ).length
    youtube.setState({ revision: 1 })
    expect(FakeWorker.instances).toHaveLength(1)
    expect(
      first.messages.filter((message) => message.type === "state")
    ).toHaveLength(initialStates)

    const staleRead = rpc(first, 7)
    provider.setState({
      provider: {
        ...plex,
        playbackSession: "second",
        getArtist: async () => ({ title: "New account" }),
      },
    })
    const second = FakeWorker.instances[1]
    expect(first.terminated).toBe(true)
    await second.receive({ type: "ready" })
    await rpc(second, 7)
    pending.shift()!({ title: "Old account" })
    await staleRead
    expect(
      second.messages.filter((message) => message.type === "reply")
    ).toEqual([{ type: "reply", id: 7, value: { title: "New account" } }])
  } finally {
    stop()
    globalThis.Worker = originalWorker
    backgroundDomains.clear()
    for (const [domain, entry] of originals)
      backgroundDomains.set(domain, entry)
  }
})
