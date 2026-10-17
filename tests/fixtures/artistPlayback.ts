import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

const dom = new JSDOM("", { url: "https://hibiki.test" })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage })
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }))
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useYoutubeMusicDiscoveryStore, youtubeMusicItemTrack } = await import("../../src/backends/ytmusic/discovery")
const { artistPlaybackSource } = await import("../../src/lib/artistPlayback")
const song = (id: string, duration: string, title = "Song") => ({
  id, kind: "song" as const, title, artist: "Artist", album: "Album", duration, thumbnail: null, year: null,
})
const duplicate = song("aaaaaaaaaaa", "3:00")
const longer = song("bbbbbbbbbbb", "6:00")
const live = song("ccccccccccc", "3:00", "Song (Live)")
const local = { ...youtubeMusicItemTrack(duplicate), id: "plex-song", streamUrl: null }
const provider: any = { cacheScope: "artist-test", playbackSession: {}, getArtistTracks: async () => [local] }
useProviderStore.getState().setProvider(provider)
useYoutubeMusicDiscoveryStore.setState({ connected: true, revision: 1 })
const source = artistPlaybackSource(provider, "plex-artist", [], {
  title: "Artist", items: [duplicate, longer, live], hubs: [], continuation: null,
})
const ready = await source.prepare!()
assert.ok(ready)
const page = await ready.loadPage(0, 10)
assert.deepEqual(page.items.map(track => track.id), ["plex-song", "ytmusic:bbbbbbbbbbb", "ytmusic:ccccccccccc"])
assert.equal(page.items[0], local)
dom.window.close()
