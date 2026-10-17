import assert from "node:assert/strict"
import { mock } from "bun:test"
import { create } from "zustand"
import type { YoutubeMusicItem } from "../../src/backends/ytmusic/discovery"
const scenario = process.argv[2]
const connection = create(() => ({ connected: true, revision: 1 }))
const likes = create(() => ({ owner: 1, entries: {} as Record<string, any>, mutation: 0 }))
const ui = create(() => ({ pageRefreshKey: 0 }))
const requests: { cursor: string | null; videos: boolean }[] = []
let receive: (update: any) => void = () => {}, release: (() => void) | undefined
const gate = new Promise<void>(resolve => { release = resolve })
const song = (id: string, type = "MUSIC_VIDEO_TYPE_ATV"): YoutubeMusicItem => ({ id, kind: "song", title: "Song", artist: "Artist", album: "Album", year: null, thumbnail: null, duration: "3:00", videoType: type })
const a = song("abcdefghijk"), b = song("lmnopqrstuv"), video = song("w1234567890", "MUSIC_VIDEO_TYPE_OMV")
mock.module("../../src/stores/uiStore", () => ({ useUIStore: ui }))
mock.module("../../src/backends/ytmusic/likes", () => ({ useYoutubeMusicLikesStore: likes }))
mock.module("../../src/backends/ytmusic/discovery", () => ({
  useYoutubeMusicDiscoveryStore: connection, useYoutubeMusicDiscovery: () => connection.getState(),
  subscribeYoutubeMusicCatalog: (listener: typeof receive) => { receive = listener },
  browseYoutubeMusic: async (_destination: unknown, cursor: string | null, _force: boolean, videos: boolean) => {
    requests.push({ cursor, videos })
    if (scenario === "account") await gate
    if (scenario === "cycle") return { items: cursor ? [] : [a], hubs: [], continuation: "one" }
    return { items: cursor === null ? (videos ? [a, video] : [a]) : cursor === "one" ? [] : cursor === "two" ? [a] : [b], hubs: [],
      continuation: cursor === null ? "one" : cursor === "one" ? "two" : cursor === "two" ? "three" : null }
  },
}))
const { loadAllYoutubeMusicLibrary, useYoutubeMusicLibraryStore: library } = await import("../../src/backends/ytmusic/library")
if (scenario === "account") {
  const old = loadAllYoutubeMusicLibrary("songs", () => true)
  connection.setState({ revision: 2 })
  release!(); await old
  assert.equal(library.getState().songs.initialized, false)
  assert.deepEqual(library.getState().songs.items, [])
} else if (scenario === "cycle") {
  await loadAllYoutubeMusicLibrary("songs", () => true)
  assert.equal(requests.length, 2)
  assert.equal(library.getState().songs.error, true)
  assert.equal(library.getState().songs.loading, false)
  assert.deepEqual(library.getState().songs.items.map(i => i.id), [a.id])
} else {
  await Promise.all([loadAllYoutubeMusicLibrary("songs", () => true), loadAllYoutubeMusicLibrary("songs", () => true)])
  assert.deepEqual(requests, [null, "one", "two", "three"].map(cursor => ({ cursor, videos: false })))
  assert.deepEqual(library.getState().songs.items.map(i => i.id), [a.id, b.id])
  await loadAllYoutubeMusicLibrary("videos", () => true)
  assert.deepEqual(library.getState().videos.items.map(i => i.id), [a.id, video.id, b.id])
  assert.deepEqual(library.getState().songs.items.map(i => i.id), [a.id, b.id])
  receive({ browseId: "VLLM", params: null, includePerformances: true, continuation: null, page: { items: [video], continuation: null } })
  assert.deepEqual(library.getState().videos.items.map(i => i.id), [video.id])
  assert.deepEqual(library.getState().songs.items.map(i => i.id), [a.id, b.id])
  likes.setState({ entries: { [`ytmusic:${video.id}`]: { manual: true, liked: false } } })
  assert.deepEqual(library.getState().videos.items, [])
  assert.deepEqual(library.getState().songs.items.map(i => i.id), [a.id, b.id])
}
