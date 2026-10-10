import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { JSDOM } from "jsdom"
import type { MusicTrack } from "../src/types/music"
import type { MusicProvider } from "../src/providers/types"
import type { AudioEngineCallbacks } from "../src/audio/RustAudioEngine"
import { deferred, settle } from "./helpers/radioAudioFakes"

const dom = new JSDOM("", { url: "https://hibiki.example.test" })
const oldStorage = globalThis.localStorage
globalThis.localStorage = dom.window.localStorage
const core = await import("@tauri-apps/api/core")
const lyricRequests = new Map<string, ReturnType<typeof deferred<any[]>>>()
mock.module("@tauri-apps/api/core", () => ({
  ...core,
  invoke: async (command: string, args: any) =>
    command === "genius_get_lyrics"
      ? lyricRequests.get(args.songUrl)?.promise
      : undefined,
}))
const events = await import("@tauri-apps/api/event")
mock.module("@tauri-apps/api/event", () => ({
  ...events,
  listen: async () => () => {},
}))
const { usePlayerStore } = await import("../src/stores/playerStore")
const { useProviderStore } = await import("../src/stores/providerStore")
const { useLyricsStore } = await import("../src/stores/lyricsStore")
const { useNotificationStore } = await import("../src/stores/notificationStore")
const notificationsEnabled =
  useNotificationStore.getState().notificationsEnabled
useNotificationStore.setState({ notificationsEnabled: false })
const { engine } = await import("../src/audio/RustAudioEngine")
const original = {
  init: engine.init,
  play: engine.play,
  stop: engine.stop,
  beginSelection: engine.beginSelection,
  preloadNext: engine.preloadNext,
  clearPreload: engine.clearPreload,
  pause: engine.pause,
  resume: engine.resume,
}
let audioCallbacks: AudioEngineCallbacks
let playbackId = 0
engine.init = async (callbacks) => {
  audioCallbacks = callbacks
}
engine.play = mock(async () => {})
engine.stop = mock(() => {})
engine.beginSelection = mock(() => {})
engine.preloadNext = mock(async () => {})
engine.clearPreload = mock(() => {})
engine.pause = mock(() => {})
engine.resume = mock(() => {})
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
    mediaInfo: { audioStreamId: 1, hasAudioStream: true },
    ...extra,
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
      endRamp: null,
    }),
    getTrack: async (id) => source(id),
    getLyrics: async () => [],
    reportProgress: mock(async () => {}),
    onTrackStart: mock(() => {}),
    onTrackEnd: mock(() => {}),
    markPlayed: mock(async () => {}),
    ...extra,
  } as MusicProvider
}

afterEach(() => {
  lyricRequests.clear()
  state().stop()
  useProviderStore.getState().clearProvider()
  ;(engine.play as any).mockClear()
  ;(engine.preloadNext as any).mockClear()
  ;(engine.beginSelection as any).mockClear()
  ;(engine.clearPreload as any).mockClear()
  ;(engine.pause as any).mockClear()
  ;(engine.resume as any).mockClear()
  state().setRadioMinQueue(5)
})

async function audiblyPlay(track: MusicTrack, context?: MusicTrack[]) {
  await state().initAudioEvents()
  await state().playTrack(track, context)
  const id = ++playbackId
  audioCallbacks.onTrackStarted({
    playback_id: id,
    rating_key: Number(track.id),
    duration_ms: track.duration,
  })
  audioCallbacks.onPosition(25000, track.duration, id)
  await settle()
  return id
}

test("enabling track radio preserves the native playback, position, lyrics, and waveform", async () => {
  const radioTracks = [
    source("1", { title: "Server copy" }),
    ...["2", "3", "4", "5", "6"].map((id) => source(id)),
  ]
  const createRadioQueue = mock(async () => ({
    queueId: 44,
    tracks: radioTracks,
  }))
  const p = provider("radio", { createRadioQueue })
  useProviderStore.getState().setProvider(p)
  const track = source("1", { title: "Bumble Bee", artistName: "Yoshiko" })
  const id = await audiblyPlay(track, [source("9"), track, source("8")])
  usePlayerStore.setState({
    waveformLevels: [{ loudness: 7 }],
    lyricsLines: [{ text: "Bee", startMs: 0, endMs: 0 }],
    albumPlaybackId: "album",
  })
  const before = state()
  const starts = (engine.play as any).mock.calls.length
  const selections = (engine.beginSelection as any).mock.calls.length
  const reported = (p.reportProgress as any).mock.calls.length
  await state().playRadio("1", "track", "Bumble Bee")
  await settle()
  expect((engine.play as any).mock.calls.length).toBe(starts)
  expect((engine.beginSelection as any).mock.calls.length).toBe(selections)
  expect((p.onTrackStart as any).mock.calls.length).toBe(1)
  expect((p.reportProgress as any).mock.calls.length).toBe(reported)
  expect(state().currentTrack).toBe(before.currentTrack)
  expect(state().positionMs).toBe(25000)
  expect(state().isPlaying).toBe(true)
  expect(state().waveformLevels).toBe(before.waveformLevels)
  expect(state().lyricsLines).toBe(before.lyricsLines)
  expect(state().queue.map((track) => track.id)).toEqual([
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
  ])
  expect(state().queueIndex).toBe(0)
  expect(state().queueId).toBe(44)
  expect(state().albumPlaybackId).toBeNull()
  expect(state().contextName).toBe("Bumble Bee Radio")
  expect((engine.clearPreload as any).mock.calls.length).toBe(1)
  expect((engine.preloadNext as any).mock.calls.at(-1)[1]).toBe(2)
  // The same native identity must continue updating the player after handoff.
  audioCallbacks.onPosition(27000, track.duration, id)
  expect(state().positionMs).toBe(27000)
  audioCallbacks.onTrackEnded({
    playback_id: id,
    rating_key: 1,
    duration_ms: track.duration,
    position_ms: 100000,
    listened_ms: 100000,
    reason: "skipped",
  })
  expect((p.onTrackEnd as any).mock.calls.length).toBe(1)
  expect((p.onTrackEnd as any).mock.calls[0][2]).toBe(100000)
  expect((p.markPlayed as any).mock.calls.length).toBe(1)
})

test("a paused radio seed stays paused when the station arrives without the seed", async () => {
  const response = deferred<{ queueId: number; tracks: MusicTrack[] }>()
  const p = provider("radio", { createRadioQueue: () => response.promise })
  useProviderStore.getState().setProvider(p)
  state().setRadioMinQueue(1)
  await audiblyPlay(source("1"))
  const radio = state().playRadio("1", "track")
  state().pause()
  response.resolve({
    queueId: 5,
    tracks: [source("2"), source("2"), source("3")],
  })
  await radio
  expect(state().isPlaying).toBe(false)
  expect(state().positionMs).toBe(25000)
  expect(state().queue.map((track) => track.id)).toEqual(["1", "2", "3"])
  expect((engine.play as any).mock.calls.length).toBe(1)
  expect((engine.resume as any).mock.calls.length).toBe(0)
})

test("radio for a different song still starts that song normally", async () => {
  useProviderStore.getState().setProvider(
    provider("radio", {
      createRadioQueue: async () => ({
        queueId: 5,
        tracks: [source("2"), source("3")],
      }),
    })
  )
  state().setRadioMinQueue(1)
  await audiblyPlay(source("1"))
  await state().playRadio("2", "track")
  expect(state().currentTrack?.id).toBe("2")
  expect(state().positionMs).toBe(0)
  expect((engine.play as any).mock.calls.length).toBe(2)
})

test("skipping while radio loads cancels its response", async () => {
  const pending = deferred<{ queueId: number; tracks: MusicTrack[] }>()
  useProviderStore
    .getState()
    .setProvider(provider("radio", { createRadioQueue: () => pending.promise }))
  state().setRadioMinQueue(1)
  await audiblyPlay(source("1"), [source("1"), source("2")])
  const radio = state().playRadio("1", "track")
  state().next()
  await settle()
  pending.resolve({ queueId: 5, tracks: [source("1"), source("3")] })
  await radio
  expect(state().currentTrack?.id).toBe("2")
  expect(state().isRadioMode).toBe(false)
  expect(state().queue.map((track) => track.id)).toEqual(["1", "2"])
})

test("stopping during the optional second radio batch prevents any delayed playback", async () => {
  const second = deferred<{ queueId: number; tracks: MusicTrack[] }>()
  let calls = 0
  useProviderStore.getState().setProvider(
    provider("radio", {
      createRadioQueue: async () =>
        ++calls === 1
          ? { queueId: 5, tracks: [source("1"), source("2")] }
          : second.promise,
    })
  )
  await audiblyPlay(source("1"))
  const radio = state().playRadio("1", "track")
  await settle()
  expect(calls).toBe(2)
  state().stop()
  second.resolve({ queueId: 6, tracks: [source("3")] })
  await radio
  expect(state().currentTrack).toBeNull()
  expect(state().queue).toEqual([])
  expect((engine.play as any).mock.calls.length).toBe(1)
})

test("a late radio response cannot replace a newer playlist selection", async () => {
  const pending = deferred<{ queueId: number; tracks: MusicTrack[] }>()
  useProviderStore.getState().setProvider(
    provider("radio", {
      createRadioQueue: () => pending.promise,
      getPlaylistItems: async () => ({ items: [source("8")], totalCount: 1 }),
    })
  )
  await audiblyPlay(source("1"))
  const radio = state().playRadio("1", "track")
  await state().playPlaylist("playlist", 1, "Playlist", "/playlist/playlist")
  pending.resolve({ queueId: 5, tracks: [source("1"), source("2")] })
  await radio
  expect(state().currentTrack?.id).toBe("8")
  expect(state().playlistKey).toBe("playlist")
  expect(state().isRadioMode).toBe(false)
})

test("provider replacement retires a pending radio response and error", async () => {
  const pending = deferred<{ queueId: number; tracks: MusicTrack[] }>()
  useProviderStore
    .getState()
    .setProvider(provider("old", { createRadioQueue: () => pending.promise }))
  await audiblyPlay(source("1"))
  const radio = state().playRadio("1", "track")
  state().stop()
  useProviderStore.getState().setProvider(provider("new"))
  await state().playTrack(source("1", { title: "New account" }))
  pending.reject(new Error("Old station failed"))
  await radio
  expect(state().currentTrack?.title).toBe("New account")
  expect(state().playerError).toBeNull()
  expect(state().isRadioMode).toBe(false)
})

test("an automatic transition while seed radio loads never jumps back to the seed", async () => {
  const pending = deferred<{ queueId: number; tracks: MusicTrack[] }>()
  useProviderStore
    .getState()
    .setProvider(provider("radio", { createRadioQueue: () => pending.promise }))
  state().setRadioMinQueue(1)
  await audiblyPlay(source("1"), [source("1"), source("2")])
  const radio = state().playRadio("1", "track")
  audioCallbacks.onTrackStarted({
    playback_id: ++playbackId,
    rating_key: 2,
    duration_ms: 180000,
  })
  pending.resolve({ queueId: 5, tracks: [source("1"), source("3")] })
  await radio
  expect(state().currentTrack?.id).toBe("2")
  expect(state().isRadioMode).toBe(false)
  expect((engine.play as any).mock.calls.length).toBe(1)
})

test("turning radio off cancels an outstanding station request", async () => {
  const pending = deferred<{ queueId: number; tracks: MusicTrack[] }>()
  useProviderStore
    .getState()
    .setProvider(provider("radio", { createRadioQueue: () => pending.promise }))
  await audiblyPlay(source("1"))
  const radio = state().playRadio("1", "track")
  state().stopRadio()
  pending.resolve({ queueId: 5, tracks: [source("1"), source("2")] })
  await radio
  expect(state().isRadioMode).toBe(false)
  expect(state().queue.map((track) => track.id)).toEqual(["1"])
  expect(state().positionMs).toBe(25000)
})

test("a late server queue ID cannot overwrite a new radio queue", async () => {
  const oldQueue = deferred<{ queueId: number; tracks: MusicTrack[] }>()
  useProviderStore.getState().setProvider(
    provider("radio", {
      createPlayQueue: () => oldQueue.promise,
      createRadioQueue: async () => ({
        queueId: 5,
        tracks: [source("1"), source("2")],
      }),
    })
  )
  state().setRadioMinQueue(1)
  const playing = state().playTrack(source("1"))
  await settle()
  await state().playRadio("1", "track")
  oldQueue.resolve({ queueId: 99, tracks: [source("1")] })
  await playing
  expect(state().queueId).toBe(5)
  expect(state().isRadioMode).toBe(true)
  expect((engine.play as any).mock.calls.length).toBe(1)
})

test("a late URI queue cannot replace a newer radio request", async () => {
  const oldQueue = deferred<{ queueId: number; tracks: MusicTrack[] }>()
  useProviderStore.getState().setProvider(
    provider("radio", {
      createPlayQueue: () => oldQueue.promise,
      createRadioQueue: async () => ({
        queueId: 5,
        tracks: [source("2"), source("3")],
      }),
    })
  )
  state().setRadioMinQueue(1)
  const old = state().playFromUri("old")
  await state().playRadio("2", "track")
  oldQueue.resolve({ queueId: 99, tracks: [source("1")] })
  await old
  expect(state().currentTrack?.id).toBe("2")
  expect(state().queueId).toBe(5)
  expect(state().isRadioMode).toBe(true)
})

test("a late playlist page cannot append tracks to a radio queue", async () => {
  const page = deferred<any>()
  useProviderStore.getState().setProvider(
    provider("radio", {
      getPlaylistItems: async (_id, offset) =>
        offset === 0
          ? { items: [source("1"), source("8")], total: 4, offset: 0 }
          : page.promise,
      createRadioQueue: async () => ({
        queueId: 5,
        tracks: [source("1"), source("2")],
      }),
    })
  )
  state().setRadioMinQueue(1)
  await state().initAudioEvents()
  await state().playPlaylist("old", 4, "Old", "/playlist/old")
  audioCallbacks.onTrackStarted({
    playback_id: ++playbackId,
    rating_key: 1,
    duration_ms: 180000,
  })
  await settle()
  expect(state().isLoadingMoreTracks).toBe(true)
  await state().playRadio("1", "track")
  page.resolve({ items: [source("9")], total: 4, offset: 2 })
  await settle()
  expect(state().queue.map((track) => track.id)).toEqual(["1", "2"])
  expect(state().isLoadingMoreTracks).toBe(false)
  expect(state().playlistLoadedCount).toBe(0)
})

test("DJ results from the old queue cannot enter the new radio queue or release its request", async () => {
  const old = deferred<{ queueId: number; tracks: MusicTrack[] }>()
  const fresh = deferred<{ queueId: number; tracks: MusicTrack[] }>()
  let calls = 0
  useProviderStore.getState().setProvider(
    provider("radio", {
      createRadioQueue: async () =>
        ++calls === 1
          ? old.promise
          : calls === 2
            ? { queueId: 5, tracks: [source("1"), source("2")] }
            : fresh.promise,
    })
  )
  state().setRadioMinQueue(1)
  await audiblyPlay(source("1"))
  state().setDjMode("freeze")
  await state().playRadio("1", "track")
  expect(calls).toBe(3)
  old.resolve({ queueId: 6, tracks: [source("9")] })
  await settle()
  expect(state().queue.map((track) => track.id)).toEqual(["1", "2"])
  fresh.resolve({ queueId: 7, tracks: [source("3")] })
  await settle()
  expect(state().queue.map((track) => track.id)).toEqual(["1", "3", "2"])
  expect((engine.preloadNext as any).mock.calls.at(-1)[1]).toBe(3)
})
afterAll(() => {
  Object.assign(engine, original)
  useNotificationStore.setState({ notificationsEnabled })
  globalThis.localStorage = oldStorage
  dom.window.close()
  mock.restore()
})

test("an old waveform cannot overwrite a later occurrence of the same song", async () => {
  const old = deferred<any[]>(),
    fresh = deferred<any[]>()
  const p = provider("a", {
    getStreamLevels: async (id) => (id === 10 ? old.promise : fresh.promise),
  })
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
    source("1", {
      codec: null,
      gain: null,
      albumGain: null,
      mediaInfo: { audioStreamId: null },
    })
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
  expect(
    (engine.play as any).mock.calls.every((call) =>
      call[0].includes("new.test")
    )
  ).toBe(true)
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
    playlistItemId: "playlist-item",
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
    .setProvider(
      provider("a", {
        getStreamLevels: () => levels.promise,
        getLyrics: () => lyrics.promise,
      })
    )
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
    .fetchGeniusLyrics({
      id: 1,
      title: "Old",
      url: "https://genius.example.test/old",
    } as any)
  await state().playTrack(source("2"))
  await settle()
  pending.resolve([{ text: "Old lyric" }])
  await lyrics
  expect(
    useLyricsStore.getState().sources.some((source) => source.id === "genius-1")
  ).toBe(false)
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
    .fetchGeniusLyrics({
      id: 1,
      title: "Old",
      url: "https://genius.example.test/old",
    } as any)
  const second = useLyricsStore
    .getState()
    .fetchGeniusLyrics({
      id: 2,
      title: "New",
      url: "https://genius.example.test/new",
    } as any)
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
    .setProvider(
      provider("a", {
        getLyrics: async () => [
          { text: "Plex lyric", startMs: 0, endMs: 1000 },
        ],
      })
    )
  await state().playTrack(source("1"))
  await settle()
  const request = useLyricsStore
    .getState()
    .fetchGeniusLyrics({
      id: 1,
      title: "Old",
      url: "https://genius.example.test/old",
    } as any)
  useLyricsStore.getState().selectSource("plex")
  pending.resolve([{ text: "Old lyric" }])
  await request
  expect(useLyricsStore.getState().activeSourceId).toBe("plex")
  expect(useLyricsStore.getState().isFetchingLyrics).toBe(false)
  expect(state().lyricsLines?.[0].text).toBe("Plex lyric")
})
