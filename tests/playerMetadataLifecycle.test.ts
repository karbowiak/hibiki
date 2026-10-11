import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { JSDOM } from "jsdom"
import type { MusicTrack } from "../src/types/music"
import type { MusicProvider } from "../src/providers/types"
import type { AudioEngineCallbacks } from "../src/audio/RustAudioEngine"
import {
  deferred,
  FakeAudio,
  FakeContext,
  settle,
} from "./helpers/radioAudioFakes"

const dom = new JSDOM("", { url: "https://hibiki.example.test" })
const oldStorage = globalThis.localStorage
const oldAudio = globalThis.Audio,
  oldContext = globalThis.AudioContext
const radioElements: FakeAudio[] = []
globalThis.Audio = class extends FakeAudio {
  constructor() {
    super()
    radioElements.push(this)
  }
} as unknown as typeof Audio
globalThis.AudioContext = FakeContext as unknown as typeof AudioContext
globalThis.localStorage = dom.window.localStorage
const savedState = new Map<string, string>()
mock.module("idb-keyval", () => ({
  get: async (key: string) => savedState.get(key),
  set: async (key: string, value: string) => {
    savedState.set(key, value)
  },
  update: async (key: string, transform: (value: unknown) => string) => { savedState.set(key, transform(savedState.get(key))) },
  del: async (key: string) => {
    savedState.delete(key)
  },
}))
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
const { usePlayerStore, preparePlaybackShutdown } = await import("../src/stores/playerStore")
const { useProviderStore } = await import("../src/stores/providerStore")
const { useLyricsStore } = await import("../src/stores/lyricsStore")
const { useNotificationStore } = await import("../src/stores/notificationStore")
const { useRadioStreamStore } = await import("../src/stores/radioStreamStore")
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
  seek: engine.seek,
  seekTo: engine.seekTo,
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
engine.seek = mock(() => {})
engine.seekTo = mock(() => {})
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
  radioElements.length = 0
  useProviderStore.getState().clearProvider()
  ;(engine.play as any).mockClear()
  ;(engine.preloadNext as any).mockClear()
  ;(engine.beginSelection as any).mockClear()
  ;(engine.clearPreload as any).mockClear()
  ;(engine.pause as any).mockClear()
  ;(engine.resume as any).mockClear()
  ;(engine.seek as any).mockClear()
  ;(engine.seekTo as any).mockClear()
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

const station = (uuid = "test-station") =>
  ({ uuid, name: uuid, stream_url: "https://radio.example.test/stream" }) as any

test("integration now-playing ownership follows native occurrences and the source provider", async () => {
  const p = provider("integration-owner")
  useProviderStore.getState().setProvider(p)
  const track = source("77")
  await audiblyPlay(track)
  const firstOwns = (p.onTrackStart as any).mock.calls.at(-1)[1] as () => boolean
  expect(firstOwns()).toBe(true)
  // Replaying the same song changes native identity even though its ID is unchanged.
  await audiblyPlay(track)
  const secondOwns = (p.onTrackStart as any).mock.calls.at(-1)[1] as () => boolean
  expect(firstOwns()).toBe(false)
  expect(secondOwns()).toBe(true)
  useProviderStore.getState().setProvider(provider("replacement"))
  expect(secondOwns()).toBe(false)
})

test("player starts and preloads with the source provider's native ownership", async () => {
  const plexContext = { connectionRevision: 8, cacheScope: `plex-${"a".repeat(64)}` }
  const p = provider("a", { getPlaybackInfo: async track => ({
    url: `https://a.test/${track.id}`, trackKey: Number(track.id), partId: 1,
    parentKey: "album", startRamp: null, endRamp: null, plexContext,
  }) })
  useProviderStore.getState().setProvider(p)
  await state().playTrack(source("1"), [source("1"), source("2")])
  await settle()
  expect((engine.play as any).mock.calls.at(-1)[9]).toEqual(plexContext)
  expect((engine.preloadNext as any).mock.calls.at(-1)[9]).toEqual(plexContext)
})

test("a transcode retry keeps the originating provider's native audio ownership", async () => {
  const plexContext = { connectionRevision: 8, cacheScope: `plex-${"a".repeat(64)}` }
  const p = provider("a", { getTranscodePlaybackInfo: async track => ({
    url: `https://a.test/transcode/${track.id}`, trackKey: Number(track.id), partId: 1,
    parentKey: "album", startRamp: null, endRamp: null, plexContext,
  }) })
  useProviderStore.getState().setProvider(p)
  await audiblyPlay(source("1"))
  usePlayerStore.setState({ positionMs: 0 })
  await audioCallbacks.onError("Unsupported test codec")
  expect((engine.play as any).mock.calls.at(-1)[0]).toBe("https://a.test/transcode/1")
  expect((engine.play as any).mock.calls.at(-1)[9]).toEqual(plexContext)
})

test("colliding podcast IDs and a positive Plex ID advance through their own native starts", async () => {
  // Aa and BB both hashed to 2112 in the old synthetic key implementation.
  const first = source("Aa", { streamUrl: "https://podcast.test/a", _providerData: { isPodcast: true } })
  const second = source("BB", { streamUrl: "https://podcast.test/b", _providerData: { isPodcast: true } })
  const plex = source("2112")
  useProviderStore.getState().setProvider(provider("a"))
  await state().initAudioEvents()
  await state().playTrack(first, [first, second, plex])
  await settle()
  const firstKey = (engine.play as any).mock.calls.at(-1)[1]
  const secondKey = (engine.preloadNext as any).mock.calls.at(-1)[1]
  expect(firstKey).toBeLessThan(0)
  expect(secondKey).toBeLessThan(0)
  expect(secondKey).not.toBe(firstKey)
  audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: firstKey, duration_ms: first.duration })
  expect(state().currentTrack?.id).toBe("Aa")
  expect(state().queueIndex).toBe(0)
  audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: secondKey, duration_ms: second.duration })
  expect(state().currentTrack?.id).toBe("BB")
  expect(state().queueIndex).toBe(1)
  await settle()
  expect((engine.preloadNext as any).mock.calls.at(-1)[1]).toBe(2112)
  audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: 2112, duration_ms: plex.duration })
  expect(state().currentTrack?.id).toBe("2112")
  expect(state().queueIndex).toBe(2)
})

test("selecting internet radio revokes a pending Plex song load", async () => {
  const pending = deferred<any>()
  useProviderStore
    .getState()
    .setProvider(provider("a", { getPlaybackInfo: () => pending.promise }))
  const playing = state().playTrack(source("1"))
  await settle()
  useRadioStreamStore.getState().playStation(station())
  pending.resolve({
    url: "https://a.test/1",
    trackKey: 1,
    partId: 1,
    parentKey: "album",
    startRamp: null,
    endRamp: null,
  })
  await playing
  expect((engine.play as any).mock.calls.length).toBe(0)
  expect(state().isInternetRadioActive).toBe(true)
  expect(state().currentTrack).toBeNull()
  expect(state().queue).toEqual([])
  expect(useRadioStreamStore.getState().currentStation?.uuid).toBe(
    "test-station"
  )
})

test("selecting internet radio revokes a pending Plex playlist selection", async () => {
  const pending = deferred<any>()
  useProviderStore
    .getState()
    .setProvider(provider("a", { getPlaylistItems: () => pending.promise }))
  const playlist = state().playPlaylist("old", 1, "Old", "/playlist/old")
  useRadioStreamStore.getState().playStation(station())
  pending.resolve({ items: [source("1")], total: 1 })
  await playlist
  expect(state().isInternetRadioActive).toBe(true)
  expect(state().queue).toEqual([])
  expect((engine.play as any).mock.calls.length).toBe(0)
})

test("returning to Plex clears the old station and ignores late radio callbacks", async () => {
  useProviderStore.getState().setProvider(provider("a"))
  useRadioStreamStore.getState().playStation(station())
  const audio = radioElements.at(-1)!
  audio.emit("playing")
  await state().playTrack(source("1"))
  audio.emit("playing")
  audio.emit("error")
  audio.flushEvents()
  expect(state().isInternetRadioActive).toBe(false)
  expect(state().currentTrack?.id).toBe("1")
  expect(useRadioStreamStore.getState().currentStation).toBeNull()
  expect(useRadioStreamStore.getState().streamError).toBeNull()
  expect(useRadioStreamStore.getState().isStreamPlaying).toBe(false)
  expect(audio.paused).toBe(true)
  expect(audio.listeners.size).toBe(0)
})

test("changing radio stations captures ownership after stopping the previous stream", () => {
  useRadioStreamStore.getState().playStation(station("old"))
  const old = radioElements.at(-1)!
  useRadioStreamStore.getState().playStation(station("new"))
  const current = radioElements.at(-1)!
  old.emit("error")
  old.flushEvents()
  current.emit("playing")
  expect(state().isInternetRadioActive).toBe(true)
  expect(useRadioStreamStore.getState().currentStation?.uuid).toBe("new")
  expect(useRadioStreamStore.getState().isStreamBuffering).toBe(false)
  expect(useRadioStreamStore.getState().streamError).toBeNull()
})

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
  // Native history owns durable final reports; renderer handoff must not duplicate them.
  expect((p.onTrackEnd as any).mock.calls.length).toBe(0)
  expect((p.markPlayed as any).mock.calls.length).toBe(0)
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
test("mute restores the selected volume and keeps the native gain curve", () => {
  const previous = {
    volume: state().volume,
    lastAudibleVolume: state().lastAudibleVolume,
  }
  const originalSetVolume = engine.setVolume
  const gains: number[] = []
  engine.setVolume = (value) => {
    gains.push(value)
  }
  try {
    state().setVolume(37)
    state().toggleMute()
    expect(state().volume).toBe(0)
    expect(state().lastAudibleVolume).toBe(37)
    state().toggleMute()
    expect(state().volume).toBe(37)
    expect(gains).toEqual([Math.pow(0.37, 3), 0, Math.pow(0.37, 3)])
    state().setVolume(0)
    state().setVolume(0)
    state().toggleMute()
    expect(state().volume).toBe(37)
  } finally {
    engine.setVolume = originalSetVolume
    usePlayerStore.setState(previous)
  }
})

test("a muted session restores its saved level and invalid remembered levels use the default", () => {
  const previous = {
    volume: state().volume,
    lastAudibleVolume: state().lastAudibleVolume,
  }
  const originalSetVolume = engine.setVolume
  engine.setVolume = () => {}
  try {
    usePlayerStore.setState({ volume: 0, lastAudibleVolume: 19 })
    state().toggleMute()
    expect(state().volume).toBe(19)
    for (const invalid of [0, -5, NaN, Infinity]) {
      usePlayerStore.setState({ volume: 0, lastAudibleVolume: invalid })
      state().toggleMute()
      expect(state().volume).toBe(80)
    }
    usePlayerStore.setState({ volume: 0, lastAudibleVolume: 999 })
    state().toggleMute()
    expect(state().volume).toBe(100)
  } finally {
    engine.setVolume = originalSetVolume
    usePlayerStore.setState(previous)
  }
})

test("nonfinite volume input cannot overwrite the selected level or enter the audio bridge", () => {
  const previous = {
    volume: state().volume,
    lastAudibleVolume: state().lastAudibleVolume,
  }
  const originalSetVolume = engine.setVolume
  const gains: number[] = []
  engine.setVolume = (value) => {
    gains.push(value)
  }
  try {
    state().setVolume(23)
    for (const invalid of [NaN, Infinity, -Infinity]) state().setVolume(invalid)
    expect(state().volume).toBe(23)
    expect(state().lastAudibleVolume).toBe(23)
    expect(gains).toEqual([Math.pow(0.23, 3)])
  } finally {
    engine.setVolume = originalSetVolume
    usePlayerStore.setState(previous)
  }
})

afterAll(() => {
  Object.assign(engine, original)
  useNotificationStore.setState({ notificationsEnabled })
  globalThis.localStorage = oldStorage
  globalThis.Audio = oldAudio
  globalThis.AudioContext = oldContext
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
  useProviderStore.getState().setProvider(
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
  const lyrics = useLyricsStore.getState().fetchGeniusLyrics({
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
  const first = useLyricsStore.getState().fetchGeniusLyrics({
    id: 1,
    title: "Old",
    url: "https://genius.example.test/old",
  } as any)
  const second = useLyricsStore.getState().fetchGeniusLyrics({
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
  useProviderStore.getState().setProvider(
    provider("a", {
      getLyrics: async () => [{ text: "Plex lyric", startMs: 0, endMs: 1000 }],
    })
  )
  await state().playTrack(source("1"))
  await settle()
  const request = useLyricsStore.getState().fetchGeniusLyrics({
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


test("keeping the app open after shutdown reloads the selected song at its saved position", async () => {
  const prepare = engine.prepareShutdown
  const seek = engine.seekTo
  engine.prepareShutdown = async () => []
  engine.seekTo = mock(() => {})
  try {
    useProviderStore.getState().setProvider(provider("resume-owner"))
    await audiblyPlay(source("77"))
    usePlayerStore.setState({ positionMs: 43210 })
    await preparePlaybackShutdown()
    expect(state().isPlaying).toBe(false)
    ;(engine.play as any).mockClear()
    state().resume()
    for (let turn = 0; turn < 5; turn++) await settle()
    expect((engine.play as any).mock.calls.length).toBe(1)
    expect((engine.seekTo as any).mock.calls).toEqual([[43210]])
    expect((engine.resume as any).mock.calls.length).toBe(0)
  } finally { engine.prepareShutdown = prepare; engine.seekTo = seek }
})

test("playlist playback uses server totals rather than a stale selection count", async () => {
  const offsets: number[] = []
  useProviderStore.getState().setProvider(provider("paging", { getPlaylistItems: async (_id, offset = 0) => {
    offsets.push(offset)
    return { items: offset === 0 ? [source("1"), source("1")] : [source("2"), source("3")], total: 4, offset }
  } }))
  await state().initAudioEvents()
  await state().playPlaylist("grown", 1, "Grown", "/playlist/grown")
  audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: 1, duration_ms: 180000 })
  await settle()
  expect(offsets).toEqual([0, 2])
  expect(state().queue.map(item => item.id)).toEqual(["1", "1", "2", "3"])
  expect(state().playlistTotalCount).toBe(4)
})

test("unknown playlist totals continue a full page and an empty response stops further requests", async () => {
  const offsets: number[] = []
  useProviderStore.getState().setProvider(provider("unknown-paging", { getPlaylistItems: async (_id, offset = 0) => {
    offsets.push(offset)
    return { items: offset === 0 ? Array.from({ length: 100 }, (_, i) => source(String(i + 1))) : [], total: 0, offset }
  } }))
  await state().initAudioEvents()
  await state().playPlaylist("unknown", 1, "Unknown", "/playlist/unknown")
  expect(state().playlistTotalCount).toBe(0)
  usePlayerStore.setState({ queueIndex: 80 })
  await state().next()
  await settle()
  expect(offsets).toEqual([0, 100])
  expect(state().playlistTotalCount).toBe(100)
  await state().next()
  await settle()
  expect(offsets).toEqual([0, 100])
})

test("unknown playback totals continue server-clamped short pages until empty", async () => {
  const offsets: number[] = []
  useProviderStore.getState().setProvider(provider("clamped-paging", { getPlaylistItems: async (_id, offset = 0) => {
    offsets.push(offset)
    return { items: offset === 0 ? [source("1")] : offset === 1 ? [source("2")] : [], total: 0, offset }
  } }))
  await state().initAudioEvents()
  await state().playPlaylist("clamped", 1, "Clamped", "/playlist/clamped")
  audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: 1, duration_ms: 180000 })
  await settle()
  expect(offsets).toEqual([0, 1])
  expect(state().playlistTotalCount).toBe(0)
  await state().next()
  await settle()
  expect(offsets).toEqual([0, 1, 2])
  expect(state().playlistTotalCount).toBe(2)
  expect(state().queue.map(item => item.id)).toEqual(["1", "2"])
})


const { usePodcastStore } = await import("../src/backends/podcast/store")
const { episodesToTracks } = await import("../src/backends/podcast/mappers")
function podcastTrack(feed: string, guid: string) {
  return episodesToTracks([{ guid, title: guid, duration_secs: 300, audio_url: `https://episodes.test/${feed}/${guid}.mp3`, description: "", pub_date: "", audio_type: "audio/mpeg", audio_size: 0, episode_number: null, season_number: null, artwork_url: null }], feed, feed, "Author", "")[0]
}
async function selectPodcast(track: MusicTrack) {
  await state().initAudioEvents()
  await state().playTrack(track, [track])
  return { playback_id: ++playbackId, rating_key: (engine.play as any).mock.calls.at(-1)[1], duration_ms: track.duration }
}

test("podcast progress persists at bounded cadence and pause/accepted seek/end without Plex submissions", async () => {
  const now = Date.now
  let clock = 1000
  Date.now = () => clock
  const podcasts = usePodcastStore.getState()
  const save = podcasts.setEpisodeProgress
  const saved: number[] = []
  usePodcastStore.setState({ listenProgress: {}, completedEpisodes: {}, setEpisodeProgress(feed, guid, seconds) { saved.push(seconds); save(feed, guid, seconds) } })
  try {
    const p = provider("podcast-connected")
    useProviderStore.getState().setProvider(p)
    const event = await selectPodcast(podcastTrack("cadence", "episode"))
    audioCallbacks.onTrackStarted(event)
    for (let i = 1; i < 50; i++) audioCallbacks.onPosition(i * 100, 300000, event.playback_id)
    expect(saved).toEqual([])
    clock += 5000
    audioCallbacks.onPosition(5000, 300000, event.playback_id)
    expect(saved).toEqual([5])
    for (let i = 51; i <= 60; i++) audioCallbacks.onPosition(i * 100, 300000, event.playback_id)
    expect(saved).toEqual([5])
    state().pause()
    expect(saved.at(-1)).toBe(6)
    audioCallbacks.onPosition(6150, 300000, event.playback_id)
    const afterTail = saved.length
    for (let i = 0; i < 20; i++) audioCallbacks.onPosition(6150, 300000, event.playback_id)
    expect(saved.length).toBe(afterTail)
    state().seekTo(90000)
    expect(saved.at(-1)).toBe(6.15)
    audioCallbacks.onPosition(6200, 300000, event.playback_id) // pre-seek packet
    expect(saved.at(-1)).toBe(6.15)
    audioCallbacks.onPosition(90000, 300000, event.playback_id)
    expect(saved.at(-1)).toBe(90)
    audioCallbacks.onTrackEnded({ ...event, position_ms: 300000, listened_ms: 10000, reason: "natural" })
    expect(saved.at(-1)).toBe(300)
    expect(usePodcastStore.getState().isEpisodeCompleted("cadence", "episode")).toBe(true)
    audioCallbacks.onTrackEnded({ ...event, position_ms: 1000, listened_ms: 1000, reason: "stopped" })
    expect(saved.at(-1)).toBe(300)
    expect((p.reportProgress as any).mock.calls.length).toBe(0)
    expect((p.markPlayed as any).mock.calls.length).toBe(0)
    expect((p.onTrackStart as any).mock.calls.length).toBe(0)
  } finally { Date.now = now; usePodcastStore.setState({ setEpisodeProgress: save }) }
})

test("podcasts restore only at native start and retain outgoing original feed identities", async () => {
  const podcasts = usePodcastStore.getState()
  podcasts.setEpisodeProgress("original", "same-guid", 120)
  const old = await selectPodcast(podcastTrack("original", "same-guid"))
  expect((engine.seekTo as any).mock.calls.length).toBe(0)
  audioCallbacks.onTrackStarted(old)
  expect((engine.seekTo as any).mock.calls).toEqual([[120000]])
  audioCallbacks.onPosition(10, 300000, old.playback_id)
  expect(podcasts.getEpisodeProgress("original", "same-guid")).toBe(120)
  audioCallbacks.onPosition(120500, 300000, old.playback_id)
  const current = await selectPodcast(podcastTrack("replacement", "same-guid"))
  audioCallbacks.onTrackStarted(current)
  audioCallbacks.onTrackEnded({ ...old, position_ms: 130000, listened_ms: 500, reason: "skipped" })
  expect(podcasts.getEpisodeProgress("original", "same-guid")).toBe(130)
  expect(podcasts.getEpisodeProgress("replacement", "same-guid")).toBe(0)
  audioCallbacks.onPosition(170000, 300000, old.playback_id)
  expect(state().positionMs).toBe(0)
  expect(podcasts.isEpisodeCompleted("original", "same-guid")).toBe(false)
})

test("completed podcasts restart at zero and an explicit buffering seek supersedes stored progress", async () => {
  const podcasts = usePodcastStore.getState()
  podcasts.setEpisodeProgress("finished", "episode", 300)
  podcasts.markEpisodeCompleted("finished", "episode")
  const finished = await selectPodcast(podcastTrack("finished", "episode"))
  audioCallbacks.onTrackStarted(finished)
  expect((engine.seekTo as any).mock.calls.length).toBe(0)
  podcasts.setEpisodeProgress("buffering", "episode", 120)
  const buffering = await selectPodcast(podcastTrack("buffering", "episode"))
  state().seekTo(40000)
  audioCallbacks.onTrackStarted(buffering)
  expect((engine.seekTo as any).mock.calls.at(-1)).toEqual([40000])
})

test("shutdown retains podcast native ending position before clearing renderer records", async () => {
  const prepare = engine.prepareShutdown
  const event = await selectPodcast(podcastTrack("shutdown", "episode"))
  audioCallbacks.onTrackStarted(event)
  audioCallbacks.onPosition(15000, 300000, event.playback_id)
  let attempts = 0
  engine.prepareShutdown = async () => {
    if (++attempts === 1) throw new Error("local retention failed")
    return [
      { ...event, playback_id: 999999, position_ms: 300000, listened_ms: 10000, reason: "natural" },
      { ...event, position_ms: 15150, listened_ms: 10000, reason: "stopped" },
    ]
  }
  try {
    await expect(preparePlaybackShutdown()).rejects.toThrow("local retention failed")
    await preparePlaybackShutdown()
    expect(usePodcastStore.getState().getEpisodeProgress("shutdown", "episode")).toBe(15.15)
    expect(usePodcastStore.getState().isEpisodeCompleted("shutdown", "episode")).toBe(false)
    state().resume()
    for (let turn = 0; turn < 5; turn++) await settle()
    expect((engine.seekTo as any).mock.calls.length).toBe(0)
    audioCallbacks.onTrackStarted({ ...event, playback_id: ++playbackId, rating_key: (engine.play as any).mock.calls.at(-1)[1] })
    expect((engine.seekTo as any).mock.calls.at(-1)).toEqual([15150])
  } finally { engine.prepareShutdown = prepare }
})
