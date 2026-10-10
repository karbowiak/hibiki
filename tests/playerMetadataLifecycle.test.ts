import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { JSDOM } from "jsdom"
import type { MusicTrack } from "../src/types/music"
import type { MusicProvider } from "../src/providers/types"
import { deferred, settle } from "./helpers/radioAudioFakes"

const dom = new JSDOM("", { url: "https://hibiki.example.test" })
const oldStorage = globalThis.localStorage
globalThis.localStorage = dom.window.localStorage
const core = await import("@tauri-apps/api/core")
const lyricRequests = new Map<string, ReturnType<typeof deferred<any[]>>>()
mock.module("@tauri-apps/api/core", () => ({
  ...core,
  invoke: async (command: string, args: any) =>
    command === "genius_get_lyrics" ? lyricRequests.get(args.songUrl)?.promise : undefined
}))
const { usePlayerStore } = await import("../src/stores/playerStore")
const { useProviderStore } = await import("../src/stores/providerStore")
const { useLyricsStore } = await import("../src/stores/lyricsStore")
const { engine } = await import("../src/audio/RustAudioEngine")
const original = {
  play: engine.play,
  stop: engine.stop,
  beginSelection: engine.beginSelection,
  preloadNext: engine.preloadNext,
  clearPreload: engine.clearPreload
}
engine.play = mock(async () => {})
engine.stop = mock(() => {})
engine.beginSelection = mock(() => {})
engine.preloadNext = mock(async () => {})
engine.clearPreload = mock(() => {})
const state = () => usePlayerStore.getState()
function source(id: string, extra: Partial<MusicTrack> = {}) {
  return {
    id,
    title: id,
    albumId: "album",
    albumName: "Album",
    artistName: "Artist",
    duration: 180000,
    codec: "flac",
    gain: -3,
    albumGain: -5,
    mediaInfo: { audioStreamId: 1 },
    ...extra
  } as MusicTrack
}
function provider(name: string, extra: Partial<MusicProvider> = {}) {
  return {
    cacheScope: name,
    getPlaybackInfo: async (track) => ({
      url: `https://${name}.test/${track.id}`,
      trackKey: Number(track.id),
      partId: 1,
      parentKey: "album",
      startRamp: null,
      endRamp: null
    }),
    getTrack: async (id) => source(id),
    getLyrics: async () => [],
    ...extra
  } as MusicProvider
}

afterEach(() => {
  lyricRequests.clear()
  state().stop()
  useProviderStore.getState().clearProvider()
  ;(engine.play as any).mockClear()
  ;(engine.preloadNext as any).mockClear()
})
afterAll(() => {
  Object.assign(engine, original)
  globalThis.localStorage = oldStorage
  dom.window.close()
  mock.restore()
})

test("an old waveform cannot overwrite a later occurrence of the same song", async () => {
  const old = deferred<any[]>(),
    fresh = deferred<any[]>()
  const p = provider("a", { getStreamLevels: async (id) => (id === 10 ? old.promise : fresh.promise) })
  useProviderStore.getState().setProvider(p)
  await state().playTrack(source("1", { mediaInfo: { audioStreamId: 10 } }))
  await settle()
  await state().playTrack(source("1", { mediaInfo: { audioStreamId: 20 } }))
  fresh.resolve([{ loudness: 2 }])
  await settle()
  old.resolve([{ loudness: 1 }])
  await settle()
  expect(state().waveformLevels).toEqual([{ loudness: 2 }])
})

test("metadata from a stopped old account cannot enrich a new account's same-ID song", async () => {
  const old = deferred<MusicTrack>()
  const p = provider("old", { getTrack: () => old.promise })
  useProviderStore.getState().setProvider(p)
  const first = state().playTrack(
    source("1", { codec: null, gain: null, albumGain: null, mediaInfo: { audioStreamId: null } })
  )
  await settle()
  state().stop()
  useProviderStore.getState().setProvider(provider("new"))
  await state().playTrack(source("1", { title: "New song" }))
  old.resolve(source("1", { title: "Old song" }))
  await first
  await settle()
  expect(state().currentTrack?.title).toBe("New song")
  expect(state().queue[0].title).toBe("New song")
  expect((engine.play as any).mock.calls.every((call) => call[0].includes("new.test"))).toBe(true)
})

test("reordering during enrichment updates the current occurrence and preserves its playlist item ID", async () => {
  const pending = deferred<MusicTrack>(),
    p = provider("a", { getTrack: () => pending.promise })
  useProviderStore.getState().setProvider(p)
  const first = source("1", {
    codec: null,
    gain: null,
    albumGain: null,
    mediaInfo: { audioStreamId: null },
    playlistItemId: "playlist-item"
  })
  const playing = state().playTrack(first, [first, source("2")])
  await settle()
  state().reorderQueue(0, 1)
  pending.resolve(source("1", { title: "Enriched song", playlistItemId: null }))
  await playing
  await settle()
  expect(state().queueIndex).toBe(1)
  expect(state().queue[0].id).toBe("2")
  expect(state().queue[1].title).toBe("Enriched song")
  expect(state().queue[1].playlistItemId).toBe("playlist-item")
})

test("stopping clears lyric requests and ignores a later waveform result", async () => {
  const levels = deferred<any[]>(),
    lyrics = deferred<any[]>()
  useProviderStore
    .getState()
    .setProvider(provider("a", { getStreamLevels: () => levels.promise, getLyrics: () => lyrics.promise }))
  await state().playTrack(source("1"))
  await settle()
  state().stop()
  levels.resolve([{ loudness: 1 }])
  lyrics.resolve([{ text: "Old lyrics", startMs: 0, endMs: 0 }])
  await settle()
  expect(state().waveformLevels).toBeNull()
  expect(state().lyricsLines).toBeNull()
  expect(useLyricsStore.getState().sources).toEqual([])
})

test("manual Genius lyrics from an earlier song cannot overwrite the new selection", async () => {
  const pending = deferred<any[]>()
  lyricRequests.set("https://genius.example.test/old", pending)
  useProviderStore.getState().setProvider(provider("a"))
  await state().playTrack(source("1"))
  await settle()
  const lyrics = useLyricsStore
    .getState()
    .fetchGeniusLyrics({ id: 1, title: "Old", url: "https://genius.example.test/old" } as any)
  await state().playTrack(source("2"))
  await settle()
  pending.resolve([{ text: "Old lyric" }])
  await lyrics
  expect(useLyricsStore.getState().sources.some((source) => source.id === "genius-1")).toBe(false)
  expect(state().lyricsLines).toEqual([])
})

test("a newer manual lyric selection wins over a delayed older hit", async () => {
  const old = deferred<any[]>(),
    next = deferred<any[]>()
  lyricRequests.set("https://genius.example.test/old", old)
  lyricRequests.set("https://genius.example.test/new", next)
  useProviderStore.getState().setProvider(provider("a"))
  await state().playTrack(source("1"))
  await settle()
  const first = useLyricsStore
    .getState()
    .fetchGeniusLyrics({ id: 1, title: "Old", url: "https://genius.example.test/old" } as any)
  const second = useLyricsStore
    .getState()
    .fetchGeniusLyrics({ id: 2, title: "New", url: "https://genius.example.test/new" } as any)
  next.resolve([{ text: "New lyric" }])
  await second
  old.resolve([{ text: "Old lyric" }])
  await first
  expect(useLyricsStore.getState().activeSourceId).toBe("genius-2")
  expect(state().lyricsLines?.[0].text).toBe("New lyric")
})

test("selecting existing Plex lyrics retires a pending manual Genius request", async () => {
  const pending = deferred<any[]>()
  lyricRequests.set("https://genius.example.test/old", pending)
  useProviderStore
    .getState()
    .setProvider(provider("a", { getLyrics: async () => [{ text: "Plex lyric", startMs: 0, endMs: 1000 }] }))
  await state().playTrack(source("1"))
  await settle()
  const request = useLyricsStore
    .getState()
    .fetchGeniusLyrics({ id: 1, title: "Old", url: "https://genius.example.test/old" } as any)
  useLyricsStore.getState().selectSource("plex")
  pending.resolve([{ text: "Old lyric" }])
  await request
  expect(useLyricsStore.getState().activeSourceId).toBe("plex")
  expect(useLyricsStore.getState().isFetchingLyrics).toBe(false)
  expect(state().lyricsLines?.[0].text).toBe("Plex lyric")
})
