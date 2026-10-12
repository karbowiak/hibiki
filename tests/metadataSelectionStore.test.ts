import { expect, test } from "bun:test"
import {
  createMetadataSelectionStore,
  metadataSelectionFor,
  metadataSelectionKey,
} from "../src/stores/metadataSelectionStore"
import { PreferencePersistence } from "../src/stores/preferencePersistence"
import { persistenceMiddleware } from "../src/stores/safePersist"
import { deferred, settle } from "./helpers/radioAudioFakes"
const identity = {
  kind: "album" as const,
  artist: "Artist",
  title: "Album",
  entityId: "42",
  scope: "account/library",
}
function harness(choices: Record<string, unknown> = {}) {
  let value = JSON.stringify({ state: { choices }, version: 0 }),
    readFailure = false,
    writeFailure = false,
    delayed = false
  const barrier = deferred<unknown>()
  const service = new PreferencePersistence({
    get: () => {
      if (readFailure) throw Error("private read details")
      return delayed ? barrier.promise : value
    },
    update: async (_, transform) => {
      if (writeFailure) throw Error("private write details")
      value = transform(value)
    },
    remove: async () => {},
  })
  return {
    service,
    barrier,
    create: () => createMetadataSelectionStore(persistenceMiddleware(service)),
    saved: () => JSON.parse(value).state.choices,
    failRead: (yes: boolean) => (readFailure = yes),
    failWrite: (yes: boolean) => (writeFailure = yes),
    delay: () => (delayed = true),
    raw: () => value,
  }
}
test("stable library identity survives rename while public name fallback and account/type remain separate", async () => {
  expect(metadataSelectionKey(identity)).toBe(
    metadataSelectionKey({
      ...identity,
      title: "Renamed",
      artist: "Renamed artist",
    })
  )
  expect(metadataSelectionKey(identity)).not.toBe(
    metadataSelectionKey({ ...identity, scope: "other" })
  )
  expect(metadataSelectionKey({ ...identity, entityId: undefined })).not.toBe(
    metadataSelectionKey({ ...identity, entityId: undefined, title: "Renamed" })
  )
  const h = harness(),
    store = h.create()
  await settle()
  store.getState().setChoice(identity, "apple")
  store.getState().setChoice(identity, "deezer", "genres")
  const renamed = { ...identity, title: "Renamed" }
  const choice = metadataSelectionFor(renamed, store.getState().choices)!
  expect(choice.identityKey).toContain("renamed")
  expect(choice.source).toBe("apple")
  expect(choice.fields?.genres).toBe("deezer")
  store.getState().setChoice(renamed, null, "genres")
  expect(metadataSelectionFor(renamed, store.getState().choices)).toMatchObject(
    { source: "apple", fields: {} }
  )
  store.getState().setChoice(renamed, null)
  expect(
    metadataSelectionFor(renamed, store.getState().choices)?.source
  ).toBeUndefined()
})
test("delayed hydration preserves local Automatic field intent and unrelated saved choices", async () => {
  const key = metadataSelectionKey(identity)!,
    other = metadataSelectionKey({ ...identity, entityId: "other" })!
  const saved = {
    [key]: { source: "apple", fields: { genres: "deezer", tags: "lastfm" } },
    [other]: { source: "plex" },
  }
  const h = harness(saved)
  h.delay()
  const store = h.create()
  store.getState().setChoice(identity, null, "genres")
  h.barrier.resolve(JSON.stringify({ state: { choices: saved }, version: 0 }))
  await settle()
  await h.service.flush()
  expect(h.saved()[key]).toEqual({
    source: "apple",
    fields: { genres: null, tags: "lastfm" },
  })
  expect(h.saved()[other]).toEqual({ source: "plex" })
})
test("failed reads preserve the saved blob through local edits; retry merges and failed writes stay recoverable", async () => {
  const key = metadataSelectionKey(identity)!,
    other = metadataSelectionKey({ ...identity, entityId: "other" })!
  const h = harness({ [other]: { source: "apple" } })
  h.failRead(true)
  const store = h.create()
  await settle()
  const original = h.raw()
  store.getState().setChoice(identity, "deezer", "genres")
  await h.service.flush()
  expect(h.raw()).toBe(original)
  h.failRead(false)
  h.failWrite(true)
  await h.service.retry()
  expect(h.saved()[other]).toEqual({ source: "apple" })
  expect(h.service.snapshot().length).toBeGreaterThan(0)
  h.failWrite(false)
  await h.service.retry()
  expect(h.saved()[key]).toEqual({ fields: { genres: "deezer" } })
  expect(h.saved()[other]).toEqual({ source: "apple" })
  expect(h.service.snapshot()).toHaveLength(0)
  const restored = h.create()
  await settle()
  expect(
    metadataSelectionFor(identity, restored.getState().choices)?.fields?.genres
  ).toBe("deezer")
})
test("invalid source/field/identity cannot store URLs or corrupt unrelated overrides", async () => {
  const h = harness(),
    store = h.create()
  await settle()
  expect(
    store.getState().setChoice(identity, "https://token.invalid" as any)
  ).toBe(false)
  expect(
    store.getState().setChoice(identity, "apple", "arbitrary" as any)
  ).toBe(false)
  expect(store.getState().setChoice({ ...identity, scope: "" }, "apple")).toBe(
    false
  )
  expect(store.getState().choices).toEqual({})
})
test("malformed saved selection protects its original blob when a new local choice is made", async () => {
  const key = metadataSelectionKey(identity)!
  const h = harness({ [key]: { source: "https://invalid.example/private" } })
  const original = h.raw(),
    store = h.create()
  await settle()
  store.getState().setChoice(identity, "apple")
  await h.service.flush()
  expect(h.raw()).toBe(original)
  expect(h.service.snapshot()).toMatchObject([
    { operation: "read", hasPendingChanges: true },
  ])
})
