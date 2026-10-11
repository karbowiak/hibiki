import { expect, test } from "bun:test"
import { createAudioSettingsStore } from "../src/stores/audioSettingsStore"
import { PreferencePersistence } from "../src/stores/preferencePersistence"
import { persistenceMiddleware } from "../src/stores/safePersist"
import { deferred, settle } from "./helpers/radioAudioFakes"

const KEY = "plex-audio-settings-v1"
const GIB = 1024 ** 3

function fixture(value: unknown) {
  let raw = JSON.stringify({ version: 0, state: value })
  let failRead = false
  let failWrite = false
  let read: Promise<unknown> | null = null
  const service = new PreferencePersistence({
    get: () => {
      if (failRead) throw new Error("storage denied")
      return read ?? raw
    },
    update: (_key, transform) => {
      if (failWrite) throw new Error("quota exhausted")
      raw = transform(raw)
    },
    remove: () => {},
  })
  const limits: number[] = []
  const audio = {
    setCacheMaxBytes: async (bytes: number) => {
      limits.push(bytes)
      return { total_bytes: 0, file_count: 0, max_bytes: bytes }
    },
    setNormalizationEnabled() {},
    setPreampGain() {},
    setCrossfadeWindow() {},
    setSameAlbumCrossfade() {},
    setSmartCrossfade() {},
    setSmartCrossfadeMax() {},
    setMixrampDb() {},
  }
  return {
    service,
    limits,
    create: () =>
      createAudioSettingsStore(audio, persistenceMiddleware(service)),
    raw: () => JSON.parse(raw),
    failRead: (value: boolean) => {
      failRead = value
    },
    failWrite: (value: boolean) => {
      failWrite = value
    },
    delayedRead: (value: Promise<unknown>) => {
      read = value
    },
  }
}

test("audio preference writes stay pending during a quota error and retry without losing the accepted limit", async () => {
  const environment = fixture({ cacheMaxBytes: 50 * GIB })
  const store = environment.create()
  await settle()
  expect(store.getState().cacheMaxBytes).toBe(50 * GIB)
  environment.failWrite(true)
  await store.getState().setCacheMaxBytes(10 * GIB)
  await settle()
  expect(store.getState().cacheMaxBytes).toBe(10 * GIB)
  expect(environment.raw().state.cacheMaxBytes).toBe(50 * GIB)
  expect(environment.service.snapshot()).toEqual([
    { key: KEY, operation: "write", hasPendingChanges: true },
  ])
  environment.failWrite(false)
  await environment.service.retry()
  expect(environment.raw().state.cacheMaxBytes).toBe(10 * GIB)
  expect(environment.service.snapshot()).toEqual([])
})

test("failed audio preference reads preserve saved data and do not apply the startup default", async () => {
  const environment = fixture({ cacheMaxBytes: 50 * GIB })
  environment.failRead(true)
  const store = environment.create()
  await settle()
  await store.getState().syncToEngine()
  expect(environment.limits).toEqual([])
  await store.getState().setCacheMaxBytes(20 * GIB)
  await settle()
  expect(environment.raw().state.cacheMaxBytes).toBe(50 * GIB)
  environment.failRead(false)
  await environment.service.retry()
  await settle()
  expect(store.getState().cacheMaxBytes).toBe(20 * GIB)
  expect(environment.raw().state.cacheMaxBytes).toBe(20 * GIB)
  expect(environment.limits).not.toContain(5 * GIB)
})

test("delayed saved audio preferences cannot overwrite a later explicitly accepted limit", async () => {
  const environment = fixture({ cacheMaxBytes: 50 * GIB })
  const reading = deferred<unknown>()
  environment.delayedRead(reading.promise)
  const store = environment.create()
  await store.getState().setCacheMaxBytes(10 * GIB)
  reading.resolve(
    JSON.stringify({ version: 0, state: { cacheMaxBytes: 50 * GIB } })
  )
  await settle()
  expect(store.getState().cacheMaxBytes).toBe(10 * GIB)
  expect(environment.limits).not.toContain(50 * GIB)
})

test("malformed saved limits cannot replace actions or mutate the native cache", async () => {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const environment = fixture({
      cacheMaxBytes: value,
      setCacheMaxBytes: "broken action",
    })
    const store = environment.create()
    await settle()
    expect(typeof store.getState().setCacheMaxBytes).toBe("function")
    expect(store.getState().cacheMaxBytes).toBe(5 * GIB)
    expect(environment.limits).toEqual([])
    expect(environment.raw().state.cacheMaxBytes).toBe(value)
    expect(environment.service.snapshot()[0]?.operation).toBe("read")
  }
})
