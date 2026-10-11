import { expect, test } from "bun:test"
import { RustAudioEngine, type AudioTransport } from "../src/audio/RustAudioEngine"
import { PlaybackJournal, type TrackEnded } from "../src/audio/playbackJournal"

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
