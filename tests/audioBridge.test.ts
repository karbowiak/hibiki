import { expect, test } from "bun:test"
import { RustAudioEngine, type AudioTransport } from "../src/audio/RustAudioEngine"
import { PlaybackJournal, type TrackEnded } from "../src/audio/playbackJournal"
import { deferred, settle } from "./helpers/radioAudioFakes"

test("cache mutations wait for native completion, preserve order and propagate failure", async () => {
  const clear = deferred<{ total_bytes: number; file_count: number; max_bytes: number }>()
  const calls: { command: string; args: unknown }[] = []
  const stats = { total_bytes: 0, file_count: 0, max_bytes: 20 }
  const audio = new RustAudioEngine({
    invoke: ((command: string, args: unknown) => {
      calls.push({ command, args })
      return command === "audio_clear_cache" ? clear.promise : Promise.resolve(stats)
    }) as AudioTransport["invoke"], listen: async () => () => {},
  })
  const clearing = audio.clearCache()
  expect(clearing).toBeInstanceOf(Promise)
  const setting = audio.setCacheMaxBytes(20)
  await settle()
  expect(calls).toHaveLength(1)
  clear.reject(new Error("disk unavailable"))
  await expect(clearing).rejects.toThrow("disk unavailable")
  expect(await setting).toEqual(stats)
  expect(calls[1]).toEqual({ command: "audio_set_cache_max_bytes", args: { bytes: 20 } })
})

test("EQ snapshots reach native admission in order and isolate their gain arrays", async () => {
  const requests: { args: any; result: ReturnType<typeof deferred<number>> }[] =
    []
  const audio = new RustAudioEngine({
    invoke: ((command: string, args: any) => {
      expect(command).toBe("audio_configure_eq")
      const result = deferred<number>()
      requests.push({ args, result })
      return result.promise
    }) as AudioTransport["invoke"],
    listen: async () => () => {},
  })
  const gains = [8, 6, 4, 2, 0, 0, 0, 0, 0, 0]
  const first = audio.configureEq({
    gainsDb: gains,
    enabled: true,
    postgainDb: null,
  })
  gains[0] = 1
  const next = audio.configureEq({
    gainsDb: gains,
    enabled: false,
    postgainDb: 2,
  })
  await settle()
  expect(requests).toHaveLength(1)
  expect(requests[0].args.gainsDb[0]).toBe(8)
  requests[0].result.resolve(-9.75)
  expect(await first).toBe(-9.75)
  await settle()
  expect(requests).toHaveLength(2)
  expect(requests[1].args.gainsDb[0]).toBe(1)
  expect(requests[1].args.enabled).toBe(false)
  requests[1].result.resolve(2)
  expect(await next).toBe(2)
})

test("an EQ admission failure cannot strand a later configuration", async () => {
  let calls = 0
  const audio = new RustAudioEngine({
    invoke: (async () => {
      if (++calls === 1) throw new Error("callback unavailable")
      return -6
    }) as AudioTransport["invoke"],
    listen: async () => () => {},
  })
  const configuration = {
    gainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    enabled: true,
    postgainDb: null,
  }
  const failed = audio.configureEq(configuration)
  const latest = audio.configureEq(configuration)
  await expect(failed).rejects.toThrow("callback unavailable")
  expect(await latest).toBe(-6)
})

test("tone and correction share one admission lane with immutable complete filter snapshots", async () => {
  const first = deferred<number>(), requests: { command: string; args: any }[] = []
  const audio = new RustAudioEngine({
    invoke: (async (command, args) => {
      requests.push({ command, args }); return requests.length === 1 ? first.promise : {
        tonePostgainDb: 0, correctionPreampDb: -6, safetyDb: 0, effectivePostgainDb: 0, sampleRate: 48000,
      }
    }) as AudioTransport["invoke"], listen: async () => () => {},
  })
  const tone = audio.configureEq({ gainsDb: Array(10).fill(0), enabled: false, postgainDb: null })
  const profile = { preampDb: -6, filters: [{ kind: "PK" as const, frequency: 1234, gainDb: 4, q: 2.5, enabled: true }] }
  const scene = audio.configureEqScene({ gainsDb: Array(10).fill(0), enabled: false, postgainDb: null, outputKey: "18446744073709551614", correction: profile })
  profile.filters[0].q = 12; profile.preampDb = 6
  expect(requests).toHaveLength(1); first.resolve(0); await tone; await scene
  expect(requests[1].command).toBe("audio_configure_eq_scene")
  expect(requests[1].args.outputKey).toBe("18446744073709551614")
  expect(requests[1].args.correction.preampDb).toBe(-6)
  expect(requests[1].args.correction.filters[0].q).toBe(2.5)
})

test("rapid EQ edits keep only the latest waiting snapshot behind the active invoke", async () => {
  const first = deferred<number>()
  const requests: any[] = []
  const audio = new RustAudioEngine({
    invoke: (async (_command, args) => {
      requests.push(args)
      return requests.length === 1 ? first.promise : -8
    }) as AudioTransport["invoke"],
    listen: async () => () => {},
  })
  const pending: Promise<number | undefined>[] = []
  for (let edit = 0; edit < 1000; edit++) {
    pending.push(
      audio.configureEq({
        gainsDb: [edit % 12, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        enabled: true,
        postgainDb: null,
      })
    )
  }
  expect(requests).toHaveLength(1)
  first.resolve(-6)
  const results = await Promise.all(pending)
  expect(requests).toHaveLength(2)
  expect(requests[1].gainsDb[0]).toBe(999 % 12)
  expect(results[0]).toBe(-6)
  expect(results.at(-1)).toBe(-8)
  expect(results.slice(1, -1).every((gain) => gain === undefined)).toBe(true)
})

function transport() {
  const handlers = new Map<string, (event: { payload: unknown }) => void>()
  let epoch = 0
  const ipc: AudioTransport = {
    invoke: async <T>(command: string) => {
      if (command === "audio_resume") throw new Error("output unavailable")
      return (command === "audio_play" ? ++epoch : command === "audio_get_sample_rate" ? 48000 : undefined) as T
    },
    listen: async (event, handler) => {
      handlers.set(event, handler as (event: { payload: unknown }) => void)
      return () => { handlers.delete(event) }
    },
  }
  return { ipc, emit: (name: string, payload: unknown) => handlers.get(name)?.({ payload }) }
}

test("queue preparation follows the confirmed selection and drops late play replies", async () => {
  const calls: { command: string; args: any }[] = []
  const first = deferred<number>(), second = deferred<number>()
  const audio = new RustAudioEngine({
    invoke: ((command: string, args: any) => {
      calls.push({ command, args })
      if (command === "audio_play") return args.ratingKey === 1 ? first.promise : second.promise
      return Promise.resolve()
    }) as AudioTransport["invoke"], listen: async () => () => {},
  })
  const track = { url: "ytmusic:abcdefghijk", ratingKey: -2, durationMs: 180000, gainDb: null, prepareWaveform: true }
  const old = audio.play("https://plex.test/one", 1, 180000, "", null)
  const latest = audio.play("https://plex.test/two", 2, 180000, "", null)
  await audio.prepareQueue([track])
  expect(calls.filter(call => call.command === "audio_prepare_queue")).toHaveLength(0)
  second.resolve(2)
  await latest
  first.resolve(1)
  await old
  await audio.prepareQueue([track])
  expect(calls.at(-1)).toEqual({ command: "audio_prepare_queue", args: { requestId: 2, batch: 1, tracks: [{ ...track, context: null }] } })
  audio.beginSelection()
  await audio.prepareQueue([track])
  audio.stop()
  await audio.prepareQueue([track])
  expect(calls.filter(call => call.command === "audio_prepare_queue")).toHaveLength(1)
})

test("a buffered native start can request its waveform with the confirmed native ID", async () => {
  const native = deferred<number>()
  const calls: { command: string; args: any }[] = []
  const handlers = new Map<string, (event: any) => void>()
  const audio = new RustAudioEngine({
    invoke: ((command: string, args: any) => {
      calls.push({ command, args })
      if (command === "audio_play") return native.promise
      return Promise.resolve(command === "audio_get_waveform" ? [{ loudness: -12 }] : 44100)
    }) as AudioTransport["invoke"],
    listen: async (event, receive) => { handlers.set(event, receive); return () => {} },
  })
  await audio.init({ onPosition() {}, onState() {}, onTrackEnded() {}, onError() {},
    onTrackStarted() { void audio.getWaveform("ytmusic:abcdefghijk", -2) },
  })
  const playing = audio.play("ytmusic:abcdefghijk", -2, 180000, "", null)
  handlers.get("audio://track-started")!({ payload: { request_id: 9, playback_id: 1, rating_key: -2, duration_ms: 180000 } })
  expect(calls.filter(call => call.command === "audio_get_waveform")).toHaveLength(0)
  native.resolve(9)
  await playing
  await settle()
  expect(calls.at(-1)).toEqual({ command: "audio_get_waveform", args: { requestId: 9, url: "ytmusic:abcdefghijk", ratingKey: -2, context: null } })
  audio.beginSelection()
  expect(await audio.getWaveform("ytmusic:abcdefghijk", -2)).toEqual([])
})

test("native ends finish their known playback record after selection changes or Stop", async () => {
  const bus = transport()
  const audio = new RustAudioEngine(bus.ipc)
  const journal = new PlaybackJournal<string>()
  const finished: string[] = []
  await audio.init({
    onPosition() {}, onState() {}, onError() {},
    onTrackStarted(event) { journal.start(event, `play-${event.playback_id}`) },
    onTrackEnded(event) { const record = journal.finish(event); if (record) finished.push(record.value) },
  })
  await audio.play("https://example.test/audio", 42, 180000, "", null)
  bus.emit("audio://track-started", { request_id: 1, playback_id: 1, rating_key: 42, duration_ms: 180000 })
  await audio.play("https://example.test/audio", 42, 180000, "", null)
  bus.emit("audio://track-started", { request_id: 2, playback_id: 2, rating_key: 42, duration_ms: 180000 })
  const end: TrackEnded = { playback_id: 1, rating_key: 42, duration_ms: 180000, listened_ms: 170000, position_ms: 175000, reason: "skipped" }
  bus.emit("audio://track-ended", { ...end, request_id: 1 })
  expect(finished).toEqual(["play-1"])
  expect(journal.currentId).toBe(2)
  audio.stop()
  bus.emit("audio://track-ended", { ...end, request_id: 3, playback_id: 2, reason: "stopped" })
  bus.emit("audio://track-ended", { ...end, request_id: 3, playback_id: 999 })
  expect(finished).toEqual(["play-1", "play-2"])
  expect(journal.currentId).toBeNull()
  audio.destroy()
})

test("a failed control command cannot masquerade as a decode error or trigger transcoding", async () => {
  const bus = transport()
  const audio = new RustAudioEngine(bus.ipc)
  const playbackErrors: string[] = []
  const controlErrors: string[] = []
  await audio.init({
    onPosition() {}, onState() {}, onTrackStarted() {}, onTrackEnded() {},
    onError(error) { playbackErrors.push(error) },
    onControlError(error) { controlErrors.push(error) },
  })
  audio.resume()
  await Promise.resolve()
  expect(controlErrors).toEqual(["Error: output unavailable"])
  expect(playbackErrors).toEqual([])
  audio.destroy()
})

test("native audio dispatch copies Plex ownership and public streams explicitly omit it", async () => {
  const calls: { command: string; args: any }[] = []
  const audio = new RustAudioEngine({
    invoke: (async (command, args) => {
      calls.push({ command, args })
      return command === "audio_play" ? 1 : undefined
    }) as AudioTransport["invoke"],
    listen: async () => () => {},
  })
  const context = {
    connectionRevision: 8,
    cacheScope: `plex-${"a".repeat(64)}`,
    token: "never forwarded",
  }
  const playing = audio.play(
    "https://server.test/track",
    7,
    180000,
    "album",
    -3,
    false,
    null,
    null,
    false,
    context
  )
  context.connectionRevision = 9
  await playing
  await audio.preloadNext(
    "https://server.test/next",
    8,
    180000,
    "album",
    -4,
    false,
    null,
    null,
    false,
    context
  )
  context.cacheScope = "replaced"
  await audio.play(
    "https://server.test/public-podcast",
    -1,
    180000,
    "",
    null,
    true
  )
  await audio.preloadNext(
    "https://server.test/public-next",
    -2,
    180000,
    "",
    null,
    true
  )
  expect(calls[0].args.context).toEqual({
    connectionRevision: 8,
    cacheScope: `plex-${"a".repeat(64)}`,
  })
  expect(calls[1].args.context).toEqual({
    connectionRevision: 9,
    cacheScope: `plex-${"a".repeat(64)}`,
  })
  expect(calls[2].args.context).toBeNull()
  expect(calls[3].args.context).toBeNull()
})
