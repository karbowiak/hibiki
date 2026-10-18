import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { JSDOM } from "jsdom"
import type { MusicTrack } from "../src/types/music"
import type { MusicProvider } from "../src/providers/types"
import type { AudioEngineCallbacks } from "../src/audio/RustAudioEngine"
import { youtubeMusicTrack } from "../src/backends/ytmusic/tracks"
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
  createStore: () => ({}),
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
let youtubeBrowsePage: import("../src/backends/ytmusic/discovery").YoutubeMusicBrowsePage | undefined
let youtubeLyricsPage: Promise<any> | undefined
let geniusHits: any[] = []
mock.module("@tauri-apps/api/core", () => ({
  ...core,
  invoke: async (command: string, args: any) =>
    command === "genius_get_lyrics"
      ? lyricRequests.get(args.songUrl)?.promise
      : command === "ytmusic_browse" ? args.browseId === "hibiki_song_lyrics" && youtubeLyricsPage ? youtubeLyricsPage : youtubeBrowsePage
      : command === "genius_search" ? geniusHits : undefined,
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
  prepareQueue: engine.prepareQueue,
  getWaveform: engine.getWaveform,
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
engine.prepareQueue = mock(async () => {})
engine.getWaveform = mock(async () => [])
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
  youtubeBrowsePage = undefined
  youtubeLyricsPage = undefined
  geniusHits = []
  state().stop()
  radioElements.length = 0
  useProviderStore.getState().clearProvider()
  ;(engine.play as any).mockClear()
  ;(engine.preloadNext as any).mockClear()
  ;(engine.prepareQueue as any).mockClear()
  engine.getWaveform = mock(async () => [])
  ;(engine.beginSelection as any).mockClear()
  ;(engine.clearPreload as any).mockClear()
  ;(engine.pause as any).mockClear()
  ;(engine.resume as any).mockClear()
  ;(engine.seek as any).mockClear()
  ;(engine.seekTo as any).mockClear()
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

test("public and podcast failures do not invoke provider transcode or replay native audio", async () => {
  const transcode = mock(async () => { throw new Error("must not transcode public content") })
  useProviderStore.getState().setProvider(provider("connected", { getTranscodePlaybackInfo: transcode }))
  await state().initAudioEvents()
  for (const track of [
    source("podcast-error", { streamUrl: "https://podcast.test/episode", _providerData: { isPodcast: true } }),
    source("external-error", { streamUrl: "https://public.test/stream" }),
  ]) {
    await state().playTrack(track, [track])
    const plays = (engine.play as any).mock.calls.length
    await audioCallbacks.onError("Unable to play this stream")
    expect(transcode).not.toHaveBeenCalled()
    expect((engine.play as any).mock.calls.length).toBe(plays)
    expect(state().playerError).toBe("Unable to play this stream")
  }
})

test("an old playback error timer cannot clear the same error on a new automatic occurrence", async () => {
  useProviderStore.getState().setProvider(provider("connected"))
  const first = source("error-first", { streamUrl: "https://public.test/first" })
  const next = source("error-next", { streamUrl: "https://public.test/next" })
  await state().initAudioEvents()
  await state().playTrack(first, [first, next])
  await settle()
  const firstKey = (engine.play as any).mock.calls.at(-1)[1]
  const nextKey = (engine.preloadNext as any).mock.calls.at(-1)[1]
  audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: firstKey, duration_ms: first.duration })
  const timers: (() => void)[] = []
  const originalTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 6000) { timers.push(() => callback(...args)); return 0 }
    return originalTimeout(callback, delay, ...args)
  }) as typeof setTimeout
  try {
    await audioCallbacks.onError("Unable to play this stream")
    audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: nextKey, duration_ms: next.duration })
    await audioCallbacks.onError("Unable to play this stream")
    expect(state().currentTrack?.id).toBe(next.id)
    timers[0]()
    expect(state().playerError).toBe("Unable to play this stream")
    // A newer identical failure on the same occurrence also owns its full timeout.
    await audioCallbacks.onError("Unable to play this stream")
    timers[1]()
    expect(state().playerError).toBe("Unable to play this stream")
    timers[2]()
    expect(state().playerError).toBeNull()
  } finally {
    globalThis.setTimeout = originalTimeout
  }
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

test("a later play selection owns a deferred cached membership lookup", async () => {
  const cached = deferred<any>()
  useProviderStore.getState().setProvider(provider("a"))
  const old = state().playPagedTracks({ key: "old-cache", total: 1, prepare: () => cached.promise, loadPage: async () => ({ items: [source("old")], total: 1 }) }, "Old", "/old", true)
  await state().playPagedTracks({ key: "new", total: 1, loadPage: async () => ({ items: [source("new")], total: 1 }) }, "New", "/new")
  cached.resolve({ key: "resolved-old", total: 1, loadPage: async () => ({ items: [source("old")], total: 1 }) })
  await old
  expect(state().currentTrack?.id).toBe("new")
  expect(state().contextName).toBe("New")
})

test("paged playback exposes the whole queue and jumps to its final song without draining earlier pages", async () => {
  const calls: number[] = []
  useProviderStore.getState().setProvider(provider("a"))
  await state().playPagedTracks({ key: "large", total: 1831, loadPage: async (offset, limit) => {
    calls.push(offset)
    return { items: Array.from({ length: Math.min(limit, 1831 - offset) }, (_, i) => source(String(offset + i))), total: 1831, offset }
  } }, "Large", "/large")
  expect(state().queue).toHaveLength(1831)
  expect(state().playlistTotalCount).toBe(1831)
  state().jumpToQueueItem(1830)
  for (let i = 0; i < 20 && state().currentTrack?.id !== "1830"; i++) await settle()
  expect(state().currentTrack?.id).toBe("1830")
  expect(state().queueIndex).toBe(1830)
  expect(calls.every(offset => offset < 5 || offset >= 1800)).toBe(true)
})

test("a saved complete queue restores its exact cursor paused and resumes from that position", async () => {
  const { initializeQueuePersistence, flushQueuePersistence } = await import("../src/lib/queuePersistence")
  const writes: any[]=[]
  const entries=Array.from({length:1831},(_,i)=>({id:String(i+1),title:`Song ${i+1}`}))
  const saved={ entries, state:{index:1400,positionMs:43210,contextName:"Liked Songs",contextHref:"/collection/tracks",albumPlaybackId:null,shuffle:true,repeat:0 as const,sourceKey:"liked:loved"} }
  const p=provider("saved",{favorites:{cachedTracks:async(ids:string[])=>ids.map(id=>source(id))} as any,savedQueue:{load:async()=>saved,save:async value=>{writes.push(value)},position:async value=>{writes.push(value)},clear:async()=>{writes.push("clear")}}})
  useProviderStore.getState().setProvider(p)
  const cleanup=initializeQueuePersistence()
  try {
    for(let i=0;i<20&&!state().queue.length;i++) await settle()
    expect(state().queue).toHaveLength(1831)
    expect(state().queueIndex).toBe(1400)
    expect(state().currentTrack?.id).toBe("1401")
    expect(state().positionMs).toBe(43210)
    expect(state().isPlaying).toBe(false)
    expect((engine.play as any).mock.calls).toHaveLength(0)
    state().resume()
    for(let i=0;i<20&&!(engine.seekTo as any).mock.calls.length;i++) await settle()
    expect((engine.seekTo as any).mock.calls).toEqual([[43210]])
    state().reorderQueue(1830,1402)
    await flushQueuePersistence()
    const snapshot=writes.findLast(value=>value.entries)
    expect(snapshot.entries).toHaveLength(1831)
    expect(snapshot.entries[1402].id).toBe("1831")
    expect(snapshot.state.shuffle).toBe(true)
  } finally {cleanup()}
})

test("a departed library cannot restore its saved queue into a newly selected library", async () => {
  const { initializeQueuePersistence } = await import("../src/lib/queuePersistence")
  const pending=deferred<any>()
  const p=provider("old",{savedQueue:{load:()=>pending.promise,save:async()=>{},position:async()=>{},clear:async()=>{}}})
  useProviderStore.getState().setProvider(p)
  const cleanup=initializeQueuePersistence()
  try {
    useProviderStore.getState().setProvider(provider("new"))
    pending.resolve({entries:[{id:"1"}],state:{index:0,positionMs:1000}})
    for(let i=0;i<10;i++)await settle()
    expect(state().queue).toEqual([])
    expect(state().currentTrack).toBeNull()
  } finally {cleanup()}
})

test("an older native process reports that saved queues need a full app restart", async () => {
  const { initializeQueuePersistence, flushQueuePersistence } = await import("../src/lib/queuePersistence")
  const { useNotificationCenterStore } = await import("../src/stores/notificationCenterStore")
  const p=provider("old-binary",{savedQueue:{load:async()=>{throw Error("Command saved_queue not found")},save:async()=>{throw Error("must not write")},position:async()=>{},clear:async()=>{}}})
  useProviderStore.getState().setProvider(p)
  const cleanup=initializeQueuePersistence()
  try {
    await settle()
    const notice=useNotificationCenterStore.getState().notifications.find(item=>item.id==="queue.persistence")
    expect(notice?.title).toBe("Restart Hibiki to enable saved queues")
    expect(notice?.message).toContain("Fully quit")
    await flushQueuePersistence()
    expect(state().queue).toEqual([])
  } finally {cleanup()}
})

test("a failed queue save stays visible and retry saves the full queue", async () => {
  const { initializeQueuePersistence, flushQueuePersistence } = await import("../src/lib/queuePersistence")
  const { useNotificationCenterStore } = await import("../src/stores/notificationCenterStore")
  let fail=true, saved:any
  const p=provider("save-retry",{savedQueue:{load:async()=>null,save:async value=>{if(fail)throw Error("disk unavailable");saved=value},position:async()=>{},clear:async()=>{}}})
  useProviderStore.getState().setProvider(p)
  const cleanup=initializeQueuePersistence()
  try {
    await settle()
    await state().playTrack(source("1"),[source("1"),source("2")])
    await expect(flushQueuePersistence()).rejects.toThrow()
    expect(useNotificationCenterStore.getState().notifications.find(item=>item.id==="queue.persistence")?.active).toBe(true)
    fail=false
    await useNotificationCenterStore.getState().runAction("queue.persistence")
    expect(saved.entries.map((entry:any)=>entry.id)).toEqual(["1","2"])
    expect(useNotificationCenterStore.getState().notifications.find(item=>item.id==="queue.persistence")?.active).toBe(false)
  } finally {cleanup()}
})

test("blocked queue writes coalesce pending orders and flush the latest cursor", async () => {
  const { initializeQueuePersistence, flushQueuePersistence } = await import("../src/lib/queuePersistence")
  const gate = deferred<void>()
  const writes: any[] = []
  const p = provider("coalesce", { savedQueue: {
    load: async () => null, clear: async () => {}, position: async () => {},
    save: async value => { writes.push(value); if (writes.length === 1) await gate.promise },
  } })
  useProviderStore.getState().setProvider(p)
  const cleanup = initializeQueuePersistence()
  try {
    await settle()
    await state().playTrack(source("1"), [source("1"), source("2"), source("3")])
    const first = flushQueuePersistence()
    await settle()
    state().reorderQueue(1, 2)
    const middle = flushQueuePersistence()
    state().reorderQueue(2, 0)
    usePlayerStore.setState({ positionMs: 1234 })
    const latest = flushQueuePersistence()
    expect(writes).toHaveLength(1)
    gate.resolve()
    await Promise.all([first, middle, latest])
    expect(writes).toHaveLength(2)
    expect(writes[1].entries.map((entry: any) => entry.id)).toEqual(state().queue.map(track => track.id))
    expect(writes[1].state.positionMs).toBe(1234)
  } finally { gate.resolve(); cleanup() }
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

test("queue radio preserves paused playback and original occurrences before appending recommendations", async () => {
  const createRadioQueue = mock(async () => ({ queueId: 44, tracks: Array.from({ length: 25 }, (_, i) => source(String(i + 1))) }))
  useProviderStore.getState().setProvider(provider("attached-radio", { createRadioQueue }))
  const queue = [source("1"), source("2"), source("3"), source("2")]
  await audiblyPlay(queue[1], queue)
  state().pause()
  const before = state(), starts = (engine.play as any).mock.calls.length
  await state().enableQueueRadio("plex")
  expect(createRadioQueue.mock.calls[0]?.[0]).toBe("1")
  expect(state().currentTrack).toBe(before.currentTrack)
  expect(state().queueIndex).toBe(before.queueIndex)
  expect(state().positionMs).toBe(before.positionMs)
  expect(state().isPlaying).toBe(false)
  expect((engine.play as any).mock.calls.length).toBe(starts)
  expect(state().queue.slice(0, queue.length)).toEqual(before.queue)
  expect(state().queue.filter(track => track.id === "2")).toHaveLength(2)
  expect(state().queue.length - state().queueIndex - 1).toBe(10)
  expect(state().queue.slice(queue.length).some(track => ["1", "2", "3"].includes(track.id))).toBe(false)
  const installed = state().queue
  await state().enableQueueRadio("plex")
  expect(state().queue).toBe(installed)
  state().stopRadio()
  expect(state().queue).toBe(installed)
})

test("attaching radio keeps long queues intact and starts fetching near their end", async () => {
  const createRadioQueue = mock(async () => ({ queueId: 44, tracks: Array.from({ length: 35 }, (_, i) => source(String(i + 101))) }))
  useProviderStore.getState().setProvider(provider("long-attached-radio", { createRadioQueue }))
  const queue = Array.from({ length: 30 }, (_, i) => source(String(i + 1)))
  await audiblyPlay(queue[8], queue)
  const before = state().queue
  await state().enableQueueRadio("plex")
  expect(state().queue).toBe(before)
  expect(state().queueIndex).toBe(8)
  expect(createRadioQueue).not.toHaveBeenCalled()
  await state().jumpToQueueItem(22)
  for (let i = 0; i < 10; i++) await settle()
  expect(state().queue.slice(0, queue.length)).toEqual(before)
  expect(state().queue.length - state().queueIndex - 1).toBe(10)
  expect(createRadioQueue).toHaveBeenCalled()
})

test("dedicated YTM and mixed queue radio keep original Plex and YTM songs in order", async () => {
  const { useYoutubeMusicDiscoveryStore } = await import("../src/backends/ytmusic/discovery")
  const previous = useYoutubeMusicDiscoveryStore.getState()
  const remote = (i: number, title = `Remote ${i}`) => youtubeMusicTrack({ videoId: String(i).padStart(11, "0"), title,
    artist: "Artist", album: "Album", duration: "3:00", thumbnail: null })
  try {
    for (const mode of ["ytmusic", "mixed"] as const) {
      state().stop()
      useYoutubeMusicDiscoveryStore.setState({ connected: true })
      youtubeBrowsePage = { title: "Radio", hubs: [], continuation: null, items: Array.from({ length: 30 }, (_, i) => ({
        id: String(i).padStart(11, "0"), kind: "song" as const, title: i === 0 ? "Seed" : `Remote ${i}`,
        artist: "Artist", album: "Album", duration: "3:00", thumbnail: null, year: null,
      })) }
      useProviderStore.getState().setProvider(provider("mixed-attached-radio", {
        search: async () => [{ ...source("1", { title: "Seed" }), type: "track" }],
        createRadioQueue: async () => ({ queueId: 77, tracks: Array.from({ length: 30 }, (_, i) => source(String(i + 100))) }),
      }))
      const queue = [remote(0, "Seed"), source("2"), remote(1), source("2")]
      usePlayerStore.setState({ queue, currentTrack: queue[1], queueIndex: 1, positionMs: 12345, isPlaying: false })
      await state().enableQueueRadio(mode)
      expect(state().queue.slice(0, queue.length)).toEqual(queue)
      expect(state().positionMs).toBe(12345)
      expect(state().queueIndex).toBe(1)
      expect(state().isPlaying).toBe(false)
      expect(state().radioMode).toBe(mode)
      const upcoming = state().queue.slice(2)
      expect(upcoming).toHaveLength(10)
      if (mode === "mixed") expect(upcoming.filter(track => track.id.startsWith("ytmusic:"))).toHaveLength(5)
      else expect(state().queue.slice(queue.length).every(track => track.id.startsWith("ytmusic:"))).toBe(true)
    }
  } finally { useYoutubeMusicDiscoveryStore.setState(previous) }
})

test("queue replacement and turning radio off retire pending attached-radio lookups", async () => {
  for (const replace of [false, true]) {
    const matching = deferred<import("../src/types/music").MusicItem[]>()
    const { useYoutubeMusicDiscoveryStore } = await import("../src/backends/ytmusic/discovery")
    useYoutubeMusicDiscoveryStore.setState({ connected: true })
    useProviderStore.getState().setProvider(provider("pending-attached-radio", { search: () => matching.promise, createRadioQueue: async () => ({ queueId: 1, tracks: [] }) }))
    const remote = youtubeMusicTrack({ videoId: "abcdefghijk", title: "Remote", artist: "Artist", album: null, duration: "3:00", thumbnail: null })
    usePlayerStore.setState({ queue: [remote], queueIndex: 0, currentTrack: remote })
    const enabling = state().enableQueueRadio("mixed")
    await settle()
    if (replace) await state().playTrack(source("99"))
    else state().stopRadio()
    const queue = state().queue
    matching.resolve([{ ...source("1", { title: "Remote" }), type: "track" }])
    await enabling
    expect(state().queue).toBe(queue)
    expect(state().isRadioMode).toBe(false)
    expect(state().radioLoading).toBe(false)
    useYoutubeMusicDiscoveryStore.setState({ connected: false })
  }
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
  const started = deferred<void>()
  useProviderStore
    .getState()
    .setProvider(provider("old", { createRadioQueue: () => { started.resolve(); return pending.promise } }))
  await audiblyPlay(source("1"))
  const radio = state().playRadio("1", "track")
  await started.promise
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
  await state().initAudioEvents()
  await state().playPlaylist("old", 4, "Old", "/playlist/old")
  audioCallbacks.onTrackStarted({
    playback_id: ++playbackId,
    rating_key: 1,
    duration_ms: 180000,
  })
  await settle()
  expect(state().queue).toHaveLength(4)
  await state().playRadio("1", "track")
  page.resolve({ items: [source("9")], total: 4, offset: 2 })
  await settle()
  expect(state().queue.map((track) => track.id)).toEqual(["1", "2"])
  expect(state().isLoadingMoreTracks).toBe(false)
  expect(state().playlistLoadedCount).toBe(0)
})

test("mixed radio for a YTM-only recording uses ten YTM recommendations", async () => {
  const { useYoutubeMusicDiscoveryStore } = await import("../src/backends/ytmusic/discovery")
  const previous = useYoutubeMusicDiscoveryStore.getState()
  const createRadioQueue = mock(async () => ({ queueId: 5, tracks: [] }))
  useProviderStore.getState().setProvider(provider("radio", { search: async () => [], createRadioQueue }))
  useYoutubeMusicDiscoveryStore.setState({ connected: true, revision: previous.revision + 1 })
  youtubeBrowsePage = { title: "Radio", hubs: [], continuation: null, items: Array.from({ length: 15 }, (_, i) => ({
    id: String(i + 1).padStart(11, "0"), kind: "song", title: `Recommendation ${i + 1}`, artist: "Artist",
    thumbnail: null, duration: "3:00", album: null, year: null,
  })) }
  try {
    const seed = youtubeMusicTrack({ videoId: "abcdefghijk", title: "YTM only", artist: "Artist", duration: "3:00", album: null, thumbnail: null })
    await state().playTrack(seed)
    const starts = (engine.play as any).mock.calls.length
    await state().playRadio(seed.id, "track", seed.title, "mixed", seed)
    expect(state().playerError).toBeNull()
    expect(state().radioMode).toBe("ytmusic")
    expect(state().queue).toHaveLength(11)
    expect(state().queue.slice(1).every(track => track.streamUrl?.startsWith("ytmusic:"))).toBe(true)
    expect((engine.play as any).mock.calls.length).toBe(starts)
    expect(createRadioQueue.mock.calls.length).toBe(0)
  } finally { useYoutubeMusicDiscoveryStore.setState(previous) }
})

test("starting radio retires Guest DJ requests and keeps DJ out of the station", async () => {
  const old = deferred<{ queueId: number; tracks: MusicTrack[] }>()
  let calls = 0
  const tracks = Array.from({ length: 11 }, (_, i) => source(String(i + 1)))
  useProviderStore.getState().setProvider(
    provider("radio", {
      createRadioQueue: async () => ++calls === 1 ? old.promise : { queueId: 5, tracks },
    })
  )
  await audiblyPlay(source("1"))
  state().setDjMode("freeze")
  await state().playRadio("1", "track")
  expect(calls).toBe(2)
  expect(state().djMode).toBeNull()
  expect(state().queue).toHaveLength(11)
  old.resolve({ queueId: 6, tracks: [source("99")] })
  await settle()
  expect(state().queue.map(track => track.id)).toEqual(tracks.map(track => track.id))
  expect(state().queueId).toBe(5)
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


test("long repeated episode selections preserve outgoing and queued preload native identities", async () => {
  await state().initAudioEvents()
  const first = podcastTrack("key-original", "first")
  const second = podcastTrack("key-original", "second")
  await state().playTrack(first, [first, second])
  const firstEvent = { playback_id: ++playbackId, rating_key: (engine.play as any).mock.calls.at(-1)[1], duration_ms: 300000 }
  audioCallbacks.onTrackStarted(firstEvent)
  await settle()
  const secondEvent = { playback_id: ++playbackId, rating_key: (engine.preloadNext as any).mock.calls.at(-1)[1], duration_ms: 300000 }
  audioCallbacks.onTrackStarted(secondEvent)
  const longGuid = "long-guid".repeat(1000)
  let selected!: MusicTrack, next!: MusicTrack
  for (let visit = 0; visit < 600; visit++) {
    // Fresh objects from repeated feed visits allocate distinct native keys.
    selected = podcastTrack("key-repeat", longGuid)
    next = podcastTrack("key-repeat", "next")
    await state().playTrack(selected, [selected, next])
  }
  const selectedEvent = { playback_id: ++playbackId, rating_key: (engine.play as any).mock.calls.at(-1)[1], duration_ms: 300000 }
  await settle()
  const nextEvent = { playback_id: ++playbackId, rating_key: (engine.preloadNext as any).mock.calls.at(-1)[1], duration_ms: 300000 }
  audioCallbacks.onTrackEnded({ ...firstEvent, position_ms: 45000, listened_ms: 1000, reason: "stopped" })
  expect(usePodcastStore.getState().getEpisodeProgress("key-original", "first")).toBe(45)
  audioCallbacks.onTrackStarted(selectedEvent)
  expect(state().currentTrack?.id).toBe(selected.id)
  audioCallbacks.onTrackStarted(nextEvent)
  expect(state().currentTrack?.id).toBe(next.id)
  audioCallbacks.onTrackEnded({ ...secondEvent, position_ms: 32000, listened_ms: 1000, reason: "skipped" })
  expect(usePodcastStore.getState().getEpisodeProgress("key-original", "second")).toBe(32)
  state().stop()
  // Stop retires unowned reverse entries while the captured old journal record
  // still owns this native ending, even with the visible queue already cleared.
  audioCallbacks.onTrackEnded({ ...selectedEvent, position_ms: 12000, listened_ms: 1000, reason: "stopped" })
  expect(usePodcastStore.getState().getEpisodeProgress("key-repeat", longGuid)).toBe(12)
})


test("custom positive provider IDs keep pending play/preload identity through queue object replacement", async () => {
  await state().initAudioEvents()
  useProviderStore.getState().setProvider(provider("custom-positive", { getPlaybackInfo: async track => ({
    url: `https://custom-positive.test/${track.id}`, trackKey: track.id === "opaque-a" ? 99 : 100,
    partId: 1, parentKey: "album", startRamp: null, endRamp: null,
  }) }))
  const first = source("opaque-a"), next = source("opaque-b")
  await state().playTrack(first, [first, next])
  await settle()
  const preloadKey = (engine.preloadNext as any).mock.calls.at(-1)[1]
  expect(preloadKey).toBe(100)
  usePlayerStore.setState({ currentTrack: { ...first }, queue: [{ ...first }, { ...next }] })
  audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: 99, duration_ms: first.duration })
  expect(state().currentTrack?.id).toBe("opaque-a")
  audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: preloadKey, duration_ms: next.duration })
  expect(state().currentTrack?.id).toBe("opaque-b")
})

test("active decoder format follows the accepted native occurrence and clears on selection", async () => {
  const p = provider("format-test")
  useProviderStore.getState().setProvider(p)
  const first = source("4401", { codec: "FLAC", bitDepth: 24, samplingRate: 96000 })
  const second = source("4402")
  await state().initAudioEvents()
  await state().playTrack(first, [first, second])
  const id = ++playbackId
  const format = { codec: "MP3", bit_depth: null, sample_rate: 44100, channels: 2 }
  audioCallbacks.onTrackStarted({ playback_id: id, rating_key: 4401, duration_ms: first.duration, source_format: format })
  expect(state().playbackFormat).toEqual({ trackId: "4401", playbackId: id, format })
  expect(state().currentTrack?.codec).toBe("FLAC")
  await state().playTrack(second, [first, second])
  expect(state().playbackFormat).toBeNull()
  // A repeated/retired start cannot bring the old format back.
  audioCallbacks.onTrackStarted({ playback_id: id, rating_key: 4401, duration_ms: first.duration, source_format: format })
  expect(state().playbackFormat).toBeNull()
})

test("YouTube Music uses native opaque sources and skips Plex queues, metadata and progress", async () => {
  const p = provider("ytmusic", {
    createPlayQueue: mock(async () => ({ queueId: 1, tracks: [] })),
    getTrack: mock(async id => source(id)),
    getLyrics: mock(async () => []),
  })
  useProviderStore.getState().setProvider(p)
  await state().initAudioEvents()
  const track = youtubeMusicTrack({ videoId: "abcdefghijk", title: "External song", artist: "Artist", album: null, duration: "3:14", thumbnail: null })
  await state().playTrack(track)
  const args = (engine.play as any).mock.calls.at(-1)
  expect(args[0]).toBe("ytmusic:abcdefghijk")
  expect(args[1]).toBeLessThan(0)
  expect(args[2]).toBe(194000)
  expect(args[9]).toBeUndefined()
  expect(args[10].track).toBe("External song")
  const native = { playback_id: ++playbackId, rating_key: args[1], duration_ms: 194000 }
  audioCallbacks.onTrackStarted(native)
  audioCallbacks.onPosition(25000, 194000, native.playback_id)
  state().pause()
  state().resume()
  await settle()
  expect((p.createPlayQueue as any).mock.calls.length).toBe(0)
  expect((p.getTrack as any).mock.calls.length).toBe(0)
  expect((p.getLyrics as any).mock.calls.length).toBe(0)
  expect((p.reportProgress as any).mock.calls.length).toBe(0)
  expect((p.onTrackStart as any).mock.calls.length).toBe(0)
})

test("mixed Plex and YouTube Music queues preload and advance with separate native keys", async () => {
  const p = provider("mixed")
  useProviderStore.getState().setProvider(p)
  await state().initAudioEvents()
  const plex = source("7001"), nextPlex = source("7002")
  const youtube = youtubeMusicTrack({ videoId: "abcdefghijk", title: "External song", artist: "Artist", album: null, duration: "3:14", thumbnail: null })
  await state().playTrack(plex, [plex, youtube, nextPlex])
  audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: 7001, duration_ms: plex.duration })
  await settle()
  const next = (engine.preloadNext as any).mock.calls.at(-1)
  expect(next[0]).toBe("ytmusic:abcdefghijk")
  expect(next[1]).toBeLessThan(0)
  const warm = (engine.prepareQueue as any).mock.calls.at(-1)[0]
  expect(warm.map((track: any) => track.url)).toEqual(["ytmusic:abcdefghijk", "https://mixed.test/7002"])
  expect(warm[0].ratingKey).toBe(next[1])
  expect(warm[0].gainDb).toBeNull()
  expect(warm[1].gainDb).toBe(-3)
  audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: next[1], duration_ms: youtube.duration })
  expect(state().currentTrack?.id).toBe(youtube.id)
  expect(state().queueIndex).toBe(1)
  await settle()
  expect((engine.preloadNext as any).mock.calls.at(-1)[1]).toBe(7002)
  audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: 7002, duration_ms: nextPlex.duration })
  expect(state().currentTrack?.id).toBe("7002")
  expect(state().queueIndex).toBe(2)
})

test("YouTube waveforms arrive after playback starts and only update their own occurrence", async () => {
  const first = deferred<{ loudness: number }[]>(), second = deferred<{ loudness: number }[]>(), stopped = deferred<{ loudness: number }[]>()
  let requested = 0
  engine.getWaveform = mock(() => [first, second, stopped][requested++].promise)
  const p = provider("yt-waveforms", { getStreamLevels: mock(async () => [{ loudness: -1 }]) })
  useProviderStore.getState().setProvider(p)
  await state().initAudioEvents()
  const song = youtubeMusicTrack({ videoId: "abcdefghijk", title: "Waveform song", artist: "Artist", album: null, duration: "3:14", thumbnail: null })
  const start = async () => {
    await state().playTrack(song)
    const key = (engine.play as any).mock.calls.at(-1)[1]
    audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: key, duration_ms: song.duration })
  }
  await start()
  expect(state().isPlaying).toBe(true)
  expect(state().waveformLevels).toBeNull()
  expect(requested).toBe(1)
  await start()
  first.resolve([{ loudness: -25 }])
  await settle()
  expect(state().waveformLevels).toBeNull()
  second.resolve([{ loudness: -12 }, { loudness: -20 }])
  await settle()
  expect(state().waveformLevels).toEqual([{ loudness: -12 }, { loudness: -20 }])
  expect((p.getStreamLevels as any).mock.calls).toHaveLength(0)
  await start()
  state().stop()
  stopped.resolve([{ loudness: -3 }])
  await settle()
  expect(state().waveformLevels).toBeNull()
})

test("provider waveforms win and queue generation is requested only for missing waveforms", async () => {
  const levels = [{ loudness: -18 }, { loudness: -6 }]
  const p = provider("waveform-priority", { getStreamLevels: async id => id === 2 ? [] : levels })
  useProviderStore.getState().setProvider(p)
  const songs = [1, 2, 3].map(id => source(String(id), { mediaInfo: { audioStreamId: id } }))
  await audiblyPlay(songs[0], songs)
  expect(state().waveformLevels).toEqual(levels)
  expect((engine.getWaveform as any).mock.calls).toHaveLength(0)
  const warm = (engine.prepareQueue as any).mock.calls.at(-1)[0]
  expect(warm.map((track: any) => [track.ratingKey, track.prepareWaveform])).toEqual([[2, true], [3, false]])
})

test("missing and failed Plex waveforms fall back to the owned cached audio", async () => {
  const context = { connectionRevision: 9, cacheScope: `plex-${"a".repeat(64)}` }
  for (const failed of [false, true]) {
    const pending = deferred<{ loudness: number }[]>()
    engine.getWaveform = mock(() => pending.promise)
    const p = provider(`waveform-fallback-${failed}`, {
      getStreamLevels: async () => { if (failed) throw Error("Analysis unavailable"); return [] },
      getPlaybackInfo: async track => ({ url: "https://plex.test/audio", trackKey: Number(track.id), partId: 1,
        parentKey: "album", startRamp: null, endRamp: null, plexContext: context }),
    })
    useProviderStore.getState().setProvider(p)
    await audiblyPlay(source("42"))
    expect((engine.getWaveform as any).mock.calls).toEqual([["https://plex.test/audio", 42, context]])
    expect(state().waveformLevels).toBeNull()
    pending.resolve([{ loudness: -24 }, { loudness: -12 }])
    await settle()
    expect(state().waveformLevels).toEqual([{ loudness: -24 }, { loudness: -12 }])
    state().stop()
  }
})

test("a missing Plex waveform uses the active transcode cache after a playback retry", async () => {
  engine.getWaveform = mock(async () => [{ loudness: -18 }])
  const context = { connectionRevision: 9, cacheScope: `plex-${"a".repeat(64)}` }
  const p = provider("waveform-transcode", {
    getTranscodePlaybackInfo: async () => ({ url: "https://plex.test/transcoded.mp3", trackKey: 42, partId: 1,
      parentKey: "album", startRamp: null, endRamp: null, plexContext: context }),
  })
  useProviderStore.getState().setProvider(p)
  await state().initAudioEvents()
  await state().playTrack(source("42"))
  await audioCallbacks.onError("Unsupported encoding")
  audioCallbacks.onTrackStarted({ playback_id: ++playbackId, rating_key: 42, duration_ms: 180000 })
  await settle()
  expect((engine.getWaveform as any).mock.calls).toEqual([["https://plex.test/transcoded.mp3", 42, context]])
})

test("a restored mixed queue rebuilds YouTube identities without sending them to Plex", async () => {
  const { restoredQueueSource } = await import("../src/lib/queuePersistence")
  const getTrack = mock(async (id: string) => source(id))
  const p = provider("restore-mixed", { getTrack })
  const saved = { entries: [
    { id: "7001" },
    { id: "ytmusic:abcdefghijk", title: "Saved external song", artistName: "Artist", duration: 194000 },
  ], state: { index: 1, positionMs: 12345, contextName: null, contextHref: null, albumPlaybackId: null, shuffle: false, repeat: 0 as const } }
  const result = await restoredQueueSource(p, saved).loadItems!([0, 1])
  expect(result.map(track => track.id)).toEqual(["7001", "ytmusic:abcdefghijk"])
  expect(result[1].streamUrl).toBe("ytmusic:abcdefghijk")
  expect(result[1].duration).toBe(194000)
  expect(getTrack.mock.calls).toEqual([["7001"]])
  expect(new URL(result[1].thumbUrl!).searchParams.get("src")).toBe("https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg")
})

test("YouTube artwork survives saving a mixed queue and repeated restores, including cold rows", async () => {
  const { initializeQueuePersistence, flushQueuePersistence } = await import("../src/lib/queuePersistence")
  let saved: any = null
  const p = provider("restore-artwork", { savedQueue: {
    load: async () => saved,
    save: async value => { saved = JSON.parse(JSON.stringify(value)) },
    position: async value => { if (saved) saved.state = value },
    clear: async () => { saved = null },
  } })
  const youtube = youtubeMusicTrack({ videoId: "abcdefghijk", title: "Saved song", artist: "Artist", album: "Album", duration: "3:14", thumbnail: "https://lh3.googleusercontent.com/album-cover=w600-h600" })
  const next = youtubeMusicTrack({ videoId: "lmnopqrstuv", title: "Queued song", artist: "Artist", album: null, duration: "2:34", thumbnail: "https://i.ytimg.com/vi/lmnopqrstuv/hqdefault.jpg" })
  useProviderStore.getState().setProvider(p)
  let cleanup = initializeQueuePersistence()
  try {
    await settle()
    await state().playTrack(youtube, [youtube, source("7001"), next])
    await flushQueuePersistence()
    expect(saved.entries[0].thumbUrl).toBe(youtube.thumbUrl)
    expect(saved.entries[2].albumThumbUrl).toBe(next.albumThumbUrl)
    cleanup()
    state().stop()
    // Restore, reorder and save again: the second YTM row stays a cold stub.
    for (let restart = 0; restart < 2; restart++) {
      cleanup = initializeQueuePersistence()
      for (let i = 0; i < 20 && !state().queue.length; i++) await settle()
      expect(state().currentTrack?.thumbUrl).toBe(youtube.thumbUrl)
      expect(state().currentTrack?.albumThumbUrl).toBe(youtube.albumThumbUrl)
      const queued = state().queue.find(track => track.id === next.id)!
      expect(queued.thumbUrl).toBe(next.thumbUrl)
      expect(queued.albumThumbUrl).toBe(next.albumThumbUrl)
      state().reorderQueue(1, 2)
      await flushQueuePersistence()
      expect(saved.entries.find((entry: any) => entry.id === next.id).thumbUrl).toBe(next.thumbUrl)
      cleanup()
      state().stop()
    }
  } finally { cleanup() }
})

const lyricSong = () => youtubeMusicTrack({ videoId: "QWERTYuiopa", title: "Lyrics track", artist: "Artist", album: "Album", duration: "3:00", thumbnail: null })
async function prepareYoutubeLyrics() {
  const { useYoutubeMusicDiscoveryStore } = await import("../src/backends/ytmusic/discovery")
  // The assertions drain microtasks; finish loading the lazy module first.
  await import("../src/backends/ytmusic/lyrics")
  const before = useYoutubeMusicDiscoveryStore.getState()
  useYoutubeMusicDiscoveryStore.setState({ connected: true, accountId: "lyrics-owner", revision: before.revision + 1 })
  usePlayerStore.setState({ currentTrack: lyricSong(), lyricsLines: null })
  return { connection: useYoutubeMusicDiscoveryStore, before }
}
for (const staleProof of [false, true]) test(`YTM counterpart search accepts a verified first-page song with continuation${staleProof ? " after an unavailable reverse mapping" : ""}`, async () => {
  const { connection, before } = await prepareYoutubeLyrics()
  const { resolveCounterpart } = await import("../src/mixedPlaylists/counterparts")
  const { trackMatchingSource } = await import("../src/matching/sources")
  const old = { ...lyricSong(), id: "ytmusic:old12345678" }
  useProviderStore.getState().setProvider(provider(`ytm-counterpart-${staleProof}`, staleProof ? {
    matchingReverse: async () => [trackMatchingSource(old)],
  } : {}))
  youtubeBrowsePage = { title: "Songs", hubs: [], continuation: "more-ranked-results", items: [
    { id: "QWERTYuiopa", kind: "song", title: "Lyrics track", artist: "Artist", album: "Album", duration: "3:00", thumbnail: null, year: null },
  ] }
  try {
    const result = await resolveCounterpart({ ...lyricSong(), id: "735", streamUrl: null }, "ytmusic", true)
    expect(result).toMatchObject({ status: "matched", track: { id: "ytmusic:QWERTYuiopa" } })
  } finally { connection.setState(before) }
})
test("YTM lyrics are preferred and work without a Plex provider", async () => {
  const { connection, before } = await prepareYoutubeLyrics()
  try {
    youtubeLyricsPage = Promise.resolve({ lyrics: { missing: false, attribution: "LyricFind", lines: [{ text: "YouTube line", startMs: 1000, endMs: 2000 }] }, items: [], hubs: [] })
    useLyricsStore.getState().fetchForTrack(lyricSong().id, "Artist", "Lyrics track")
    for (let i = 0; i < 10; i++) await settle()
    expect(useLyricsStore.getState().activeSourceId).toBe("ytmusic")
    expect(state().lyricsLines?.[0].text).toBe("YouTube line")
    expect(useLyricsStore.getState().sources[0].isSynced).toBe(true)
    expect(useLyricsStore.getState().isFetchingLyrics).toBe(false)
  } finally { state().stop(); connection.setState(before) }
})
test("missing YTM lyrics use a verified Plex recording, never the video ID", async () => {
  const { connection, before } = await prepareYoutubeLyrics()
  const local = { ...source("735", { title: "Lyrics track", artistName: "Artist", albumName: "Album", duration: 180000 }), artistCredits: [{ name: "Artist" }] }
  const getLyrics = mock(async () => [{ text: "Plex fallback", startMs: 0, endMs: 0 }])
  useProviderStore.getState().setProvider(provider("lyrics-fallback", { findPlaylistCandidates: async () => ({ tracks: [local], truncated: false, unavailable: false }), getTrack: async () => local, getLyrics }))
  try {
    const verified = await (await import("../src/mixedPlaylists/counterparts")).resolveCounterpart(lyricSong(), "plex")
    expect(verified.status).toBe("matched")
    youtubeLyricsPage = Promise.resolve({ lyrics: { missing: true, lines: [] }, items: [], hubs: [] })
    useLyricsStore.getState().fetchForTrack(lyricSong().id, "Artist", "Lyrics track")
    for (let i = 0; i < 20; i++) await settle()
    expect(getLyrics).toHaveBeenCalledWith("735")
    expect(getLyrics).not.toHaveBeenCalledWith(lyricSong().id)
    expect(useLyricsStore.getState().activeSourceId).toBe("plex")
  } finally { state().stop(); connection.setState(before) }
})
test("a failed YTM request falls back to Genius without Plex and settles loading", async () => {
  const { connection, before } = await prepareYoutubeLyrics()
  const { useGeniusStore } = await import("../src/metadata/genius/authStore")
  const { useUIStore } = await import("../src/stores/uiStore")
  const geniusBefore = useGeniusStore.getState(), uiBefore = useUIStore.getState()
  useGeniusStore.setState({ hasCredentials: true, isEnabled: true, alwaysFetch: false })
  useUIStore.setState({ isLyricsOpen: true })
  const pending = deferred<any[]>()
  lyricRequests.set("https://genius.example.test/fallback", pending)
  geniusHits = [{ id: 55, url: "https://genius.example.test/fallback", title: "Song", relevance: 1 }]
  try {
    const response = deferred<any>()
    youtubeLyricsPage = response.promise
    useLyricsStore.getState().fetchForTrack(lyricSong().id, "Artist", "Lyrics track")
    await settle(); response.reject(Error("Unavailable"))
    pending.resolve([{ text: "Genius fallback" }])
    for (let i = 0; i < 20; i++) await settle()
    expect(state().lyricsLines?.[0].text).toBe("Genius fallback")
    expect(useLyricsStore.getState().sources[0].label).toBe("Genius")
    expect(useLyricsStore.getState().isFetchingLyrics).toBe(false)
  } finally { state().stop(); connection.setState(before); useGeniusStore.setState(geniusBefore); useUIStore.setState(uiBefore) }
})
test("an account change retires pending YTM lyrics without publishing its old source", async () => {
  const { connection, before } = await prepareYoutubeLyrics()
  const response = deferred<any>()
  youtubeLyricsPage = response.promise
  try {
    useLyricsStore.getState().fetchForTrack(lyricSong().id, "Artist", "Lyrics track")
    await settle()
    connection.setState({ connected: false, accountId: null, revision: connection.getState().revision + 1 })
    response.resolve({ lyrics: { missing: false, lines: [{ text: "Old account", startMs: 0, endMs: 0 }] }, items: [], hubs: [] })
    for (let i = 0; i < 10; i++) await settle()
    expect(useLyricsStore.getState().sources).toEqual([])
    expect(state().lyricsLines).toEqual([])
    expect(useLyricsStore.getState().isFetchingLyrics).toBe(false)
  } finally { state().stop(); connection.setState(before) }
})
