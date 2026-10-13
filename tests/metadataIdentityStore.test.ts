import { expect, test } from "bun:test"
import {
  createMetadataIdentityStore,
  identityChoiceFor,
  metadataIdentityItemKey,
  validIdentityCandidate,
} from "../src/stores/metadataIdentityStore"
import { PreferencePersistence } from "../src/stores/preferencePersistence"
import { persistenceMiddleware } from "../src/stores/safePersist"
import { deferred, settle } from "./helpers/radioAudioFakes"
const identity = {
  kind: "artist" as const,
  artist: "Library name",
  entityId: "42",
  scope: "account/library",
}
const candidate = {
  provider: "musicbrainz" as const,
  kind: "artist" as const,
  id: "51497a0b-fd77-48dc-9cb0-bfe8ce205173",
  title: "Canonical name",
  artist: "Canonical name",
  aliases: [{ name: "Translated name", locale: "ja" }],
  artistCredits: [],
  identifiers: { artistMbid: "51497a0b-fd77-48dc-9cb0-bfe8ce205173" },
}
const review = { candidate, fields: {}, reviewedAt: 1 }
function harness() {
  let value = JSON.stringify({ state: { choices: {} }, version: 0 }),
    fail = false
  const barrier = deferred<unknown>()
  const service = new PreferencePersistence({
    get: () =>
      barrier.promise.then((saved) => {
        if (typeof saved === "string") value = saved
        return saved
      }),
    update: async (_, transform) => {
      if (fail) throw Error("private")
      value = transform(value)
    },
    remove: async () => {},
  })
  const store = createMetadataIdentityStore(persistenceMiddleware(service))
  return {
    store,
    service,
    barrier,
    saved: () => JSON.parse(value).state.choices,
    fail: (v: boolean) => (fail = v),
  }
}
test("reviewed stable entity survives library rename, keeps original labels, and never borrows another ID", async () => {
  const h = harness()
  h.barrier.resolve(null)
  await settle()
  expect(h.store.getState().setReviewed(identity, review)).toBe(true)
  const choices = h.store.getState().choices
  expect(
    identityChoiceFor({ ...identity, artist: "Renamed" }, choices)?.candidate.id
  ).toBe(candidate.id)
  expect(identityChoiceFor({ ...identity, entityId: "43" }, choices)).toBeNull()
  expect(identityChoiceFor({ ...identity, scope: "other" }, choices)).toBeNull()
  expect(
    identityChoiceFor({ ...identity, entityId: undefined }, choices)
      ?.libraryArtist
  ).toBe("Library name")
  h.store.getState().setReviewed(
    { ...identity, entityId: "43" },
    {
      ...review,
      candidate: {
        ...candidate,
        id: "fde1a1f9-a32e-4abf-b0de-f894c6720f4a",
        identifiers: { artistMbid: "fde1a1f9-a32e-4abf-b0de-f894c6720f4a" },
      },
    }
  )
  expect(
    identityChoiceFor(
      { ...identity, entityId: undefined },
      h.store.getState().choices
    )
  ).toBeNull()
})
test("local Reset before hydration preserves explicit intent and unrelated saved choices", async () => {
  const h = harness()
  h.store.getState().reset(identity)
  const key = metadataIdentityItemKey(identity)!,
    other = metadataIdentityItemKey({ ...identity, entityId: "other" })!
  const saved = {
    [key]: {
      candidate,
      libraryArtist: identity.artist,
      version: crypto.randomUUID(),
    },
    [other]: {
      candidate,
      libraryArtist: "Other",
      version: crypto.randomUUID(),
    },
  }
  h.barrier.resolve(JSON.stringify({ state: { choices: saved }, version: 0 }))
  await settle()
  await h.service.flush()
  expect(h.saved()[key]).toBeNull()
  expect(h.saved()[other]).toEqual(saved[other])
  expect(h.store.getState().hydrated).toBe(true)
})
test("failed write retains scoped reviewed choice and retry persists without URLs or credential fields", async () => {
  const h = harness()
  h.barrier.resolve(null)
  await settle()
  h.fail(true)
  expect(h.store.getState().setReviewed(identity, review)).toBe(true)
  await settle()
  await h.service.flush()
  expect(h.service.snapshot().length).toBe(1)
  expect(
    h.store.getState().choices[metadataIdentityItemKey(identity)!]?.candidate
  ).toEqual(candidate)
  h.fail(false)
  await h.service.retry()
  expect(h.saved()[metadataIdentityItemKey(identity)!].candidate).toEqual(
    candidate
  )
  expect(
    validIdentityCandidate({
      ...candidate,
      url: "https://private.example?token=secret",
    })
  ).toBe(false)
  expect(validIdentityCandidate({ ...candidate, provider: "heya" })).toBe(false)
  expect(
    validIdentityCandidate({
      ...candidate,
      provider: "heya",
      connectionId: crypto.randomUUID(),
    })
  ).toBe(true)
})
