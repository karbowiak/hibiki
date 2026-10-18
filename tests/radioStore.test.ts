import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { JSDOM } from "jsdom"
import type { RadioStation } from "../src/lib/radiobrowser"
import { deferred, FakeAudio, FakeContext, settle } from "./helpers/radioAudioFakes"

const dom = new JSDOM("", { url: "https://hibiki.example.test" })
const originals = { localStorage: globalThis.localStorage, Audio: globalThis.Audio, AudioContext: globalThis.AudioContext }
globalThis.localStorage = dom.window.localStorage
const elements: FakeAudio[] = []
globalThis.Audio = class extends FakeAudio { constructor() { super(); elements.push(this) } } as unknown as typeof Audio
globalThis.AudioContext = FakeContext as unknown as typeof AudioContext

// Exercise the real stores and audio player without IPC, user storage or station metrics.
const core = await import("@tauri-apps/api/core")
const events = await import("@tauri-apps/api/event")
mock.module("@tauri-apps/api/core", () => ({ ...core, invoke: async () => undefined }))
const storage = new Map<string, string>()
const applicationStorage = await import("../src/storage/clientStorage")
mock.module("../src/storage/clientStorage", () => ({ ...applicationStorage,
  get: async (name: string) => storage.get(name),
  set: async (name: string, value: string) => { storage.set(name, value) },
  update: async (name: string, transform: (value: unknown) => string) => { storage.set(name, transform(storage.get(name))) },
  del: async (name: string) => { storage.delete(name) },
}))
const registrations: { handler: (e: { payload: string }) => void; registration: ReturnType<typeof deferred<() => void>>; unlisten: ReturnType<typeof mock> }[] = []
mock.module("@tauri-apps/api/event", () => ({ ...events, listen: (_name: string, handler: (e: { payload: string }) => void) => {
  const registration = deferred<() => void>()
  registrations.push({ handler, registration, unlisten: mock(() => {}) })
  return registration.promise
} }))

const { useRadioStreamStore } = await import("../src/stores/radioStreamStore")
const { usePlayerStore } = await import("../src/stores/playerStore")
const { radioStop } = await import("../src/lib/radioAudio")

const station = (uuid: string) => ({ uuid, name: uuid, stream_url: `https://radio.example.test/${uuid}`, tags: [] }) as RadioStation
const play = (uuid: string) => useRadioStreamStore.getState().playStation(station(uuid))
const state = () => useRadioStreamStore.getState()

afterEach(() => {
  state().stopStream()
  state().clearRecent()
  elements.splice(0)
  registrations.splice(0)
})
afterAll(() => {
  Object.assign(globalThis, originals)
  dom.window.close()
  mock.restore()
})

describe("radio station ownership", () => {
  test("late ICY registrations are released and superseded metadata and audio events are ignored", async () => {
    play("A")
    const a = registrations[0]
    const audioA = elements[0]
    play("B")
    const b = registrations[1]
    a.registration.resolve(a.unlisten)
    b.registration.resolve(b.unlisten)
    await settle()
    expect(a.unlisten).toHaveBeenCalledTimes(1)
    expect(b.unlisten).toHaveBeenCalledTimes(0)
    b.handler({ payload: "StreamTitle='Current Artist - Current Song';" })
    expect(state().icyNowPlaying).toEqual({ artist: "Current Artist", title: "Current Song" })
    a.handler({ payload: "StreamTitle='Stale Artist - Stale Song';" })
    audioA.emit("playing")
    audioA.emit("error")
    audioA.flushEvents()
    expect(state().currentStation?.uuid).toBe("B")
    expect(state().icyNowPlaying?.title).toBe("Current Song")
    expect(state().streamError).toBeNull()
    expect(state().isStreamBuffering).toBe(true)
    elements[1].emit("playing")
    expect(state().isStreamPlaying).toBe(true)
    expect(state().isStreamBuffering).toBe(false)
  })

  test("stopping during listener registration prevents later metadata from reviving the station", async () => {
    play("A")
    const a = registrations[0]
    state().stopStream()
    a.registration.resolve(a.unlisten)
    await settle()
    a.handler({ payload: "StreamTitle='Old Artist - Old Song';" })
    expect(a.unlisten).toHaveBeenCalledTimes(1)
    expect(state().currentStation).toBeNull()
    expect(state().icyNowPlaying).toBeNull()
    expect(usePlayerStore.getState().isInternetRadioActive).toBe(false)
  })

  test("switching away through the audio wrapper also clears the store and native metadata listener", async () => {
    play("A")
    const a = registrations[0]
    a.registration.resolve(a.unlisten)
    await settle()
    radioStop()
    expect(a.unlisten).toHaveBeenCalledTimes(1)
    expect(state().currentStation).toBeNull()
    expect(state().isStreamPlaying).toBe(false)
    expect(state().isStreamBuffering).toBe(false)
    expect(usePlayerStore.getState().isInternetRadioActive).toBe(false)
    a.handler({ payload: "StreamTitle='Old Artist - Old Song';" })
    expect(state().icyNowPlaying).toBeNull()
  })

  test("a stale error timer cannot clear a newer station's error", async () => {
    const previousSet = globalThis.setTimeout, previousClear = globalThis.clearTimeout
    const queued: (() => void)[] = []
    globalThis.setTimeout = ((fn: () => void) => { queued.push(fn); return queued.length }) as unknown as typeof setTimeout
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout
    try {
      play("A")
      await settle()
      elements[0].emit("error")
      expect(queued).toHaveLength(1)
      play("B")
      await settle()
      elements[1].emit("error")
      const errorB = state().streamError
      queued[0]()
      expect(state().streamError).toBe(errorB)
      queued[1]()
      expect(state().streamError).toBeNull()
    } finally {
      globalThis.setTimeout = previousSet
      globalThis.clearTimeout = previousClear
    }
  })

  test("initialization failure leaves an actionable error instead of endless buffering", () => {
    const previous = globalThis.AudioContext
    globalThis.AudioContext = class { constructor() { throw new Error("unavailable") } } as unknown as typeof AudioContext
    try {
      play("A")
      expect(state().isStreamPlaying).toBe(false)
      expect(state().isStreamBuffering).toBe(false)
      expect(state().streamError).toBe("Could not initialize radio audio. Try playing the station again.")
    } finally { globalThis.AudioContext = previous }
  })
})
