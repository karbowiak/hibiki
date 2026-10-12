import { expect, test } from "bun:test"
import {
  artworkPreferenceKey,
  artworkRevisionKey,
  applyArtworkRevision,
  createArtworkPreferenceStore,
} from "../src/stores/artworkPreferenceStore"
import { PreferencePersistence } from "../src/stores/preferencePersistence"
import { persistenceMiddleware } from "../src/stores/safePersist"
import { deferred, settle } from "./helpers/radioAudioFakes"
const name = "artwork-source-choices-v1"
function harness(saved: Record<string, unknown> = {}) {
  let value = JSON.stringify({ state: { choices: saved }, version: 0 })
  let readFailure = false,
    writeFailure = false
  const barrier = deferred<unknown>()
  let delayed = false
  const service = new PreferencePersistence({
    get: () => {
      if (readFailure) throw new Error("Synthetic read failure")
      return delayed ? barrier.promise : value
    },
    update: async (_, transform) => {
      if (writeFailure) throw new Error("Synthetic write failure")
      value = transform(value)
    },
    remove: async () => {},
  })
  return {
    service,
    barrier,
    create: () => createArtworkPreferenceStore(persistenceMiddleware(service)),
    saved: () => JSON.parse(value).state.choices,
    savedState: () => JSON.parse(value).state,
    delay: () => {
      delayed = true
    },
    failRead: (fail: boolean) => {
      readFailure = fail
    },
    failWrite: (fail: boolean) => {
      writeFailure = fail
    },
  }
}
test("scoped normalized names share preferences without URLs and separate accounts/types", () => {
  const artist = artworkPreferenceKey(
    "account-library-a",
    "artist",
    " Artist "
  )!
  expect(artist).toBe(
    artworkPreferenceKey("account-library-a", "artist", "artist")
  )
  expect(artist).not.toBe(
    artworkPreferenceKey("account-library-b", "artist", "Artist")
  )
  expect(artist).not.toBe(
    artworkPreferenceKey("account-library-a", "album", "Artist", "Album")
  )
  expect(artworkPreferenceKey(null, "artist", "Artist")).toBeNull()
  const h = harness(),
    store = h.create()
  store.getState().setChoice(artist, "apple")
  expect(store.getState().choices).toEqual({})
})
test("late hydration preserves local choices and Automatic reset without deleting other saved items", async () => {
  const a = artworkPreferenceKey("a", "album", "Artist", "Album")!,
    b = artworkPreferenceKey("a", "artist", "Other")!,
    c = artworkPreferenceKey("b", "artist", "Artist")!
  const h = harness({ [a]: "apple", [b]: "deezer" })
  h.delay()
  const store = h.create()
  store.getState().setChoice(a, null)
  store.getState().setChoice(c, "plex")
  h.barrier.resolve(
    JSON.stringify({
      state: { choices: { [a]: "apple", [b]: "deezer" } },
      version: 0,
    })
  )
  await settle()
  await h.service.flush()
  expect(store.getState().choices).toEqual({
    [a]: null,
    [b]: "deezer",
    [c]: "plex",
  })
  expect(h.saved()).toEqual(store.getState().choices)
})
test("failed hydration never overwrites saved choices; retry merges intent and failed writes remain retryable", async () => {
  const a = artworkPreferenceKey("a", "artist", "Artist")!,
    b = artworkPreferenceKey("b", "artist", "Other")!
  const h = harness({ [a]: "deezer" })
  h.failRead(true)
  const store = h.create()
  await settle()
  store.getState().setChoice(b, "plex")
  await settle()
  await h.service.flush()
  expect(h.saved()).toEqual({ [a]: "deezer" })
  expect(h.service.snapshot().length).toBe(1)
  h.failRead(false)
  h.failWrite(true)
  await h.service.retry()
  await settle()
  expect(store.getState().choices[a]).toBe("deezer")
  expect(h.saved()[b]).toBeUndefined()
  expect(h.service.snapshot().length).toBe(1)
  h.failWrite(false)
  await h.service.retry()
  await h.service.flush()
  expect(h.saved()).toEqual({ [a]: "deezer", [b]: "plex" })
  expect(h.service.snapshot()).toEqual([])
})

test("malformed saved source values remain untouched when a new preference is chosen", async () => {
  const key = artworkPreferenceKey("a", "artist", "Artist")!
  const h = harness({ [key]: "https://synthetic.test/not-a-source" })
  const store = h.create()
  await settle()
  expect(store.getState().choices).toEqual({})
  store.getState().setChoice(key, "plex")
  await settle()
  await h.service.flush()
  expect(h.saved()).toEqual({ [key]: "https://synthetic.test/not-a-source" })
  expect(h.service.snapshot().length).toBe(1)
})

test("image revisions are bounded, source-specific, account-scoped and never persisted", async () => {
  const h = harness(),
    store = h.create()
  await settle()
  const url =
    "image://localhost/ext/img?src=https%3A%2F%2Fsynthetic.test%2Fcover&scope=a"
  store.getState().rememberRevision("a", url, "revision-a")
  expect(store.getState().revisions[artworkRevisionKey("a", url)!]).toBe(
    "revision-a"
  )
  expect(
    store.getState().revisions[artworkRevisionKey("b", url)!]
  ).toBeUndefined()
  const revised = applyArtworkRevision(url, "revision-a")!
  expect(artworkRevisionKey("a", revised)).toBe(artworkRevisionKey("a", url))
  expect(new URL(revised).searchParams.get("src")).toBe(
    "https://synthetic.test/cover"
  )
  await h.service.flush()
  expect(h.saved()).toEqual({})
  for (let i = 0; i < 520; i++)
    store.getState().rememberRevision("a", `${url}&item=${i}`, `r-${i}`)
  expect(Object.keys(store.getState().revisions).length).toBe(512)
})

test("poster keys remain compatible while background intent and refresh revisions stay independent", async () => {
  const poster = artworkPreferenceKey("a", "album", "Artist", "Album")!
  const background = artworkPreferenceKey(
    "a",
    "album",
    "Artist",
    "Album",
    "background"
  )!
  expect(poster).toBe(JSON.stringify(["a", "album", "artist", "album"]))
  expect(background).not.toBe(poster)
  const h = harness({ [poster]: "apple", [background]: "plex" }),
    store = h.create()
  await settle()
  expect(store.getState().choices).toEqual({
    [poster]: "apple",
    [background]: "plex",
  })
  store.getState().setChoice(background, "deezer")
  await h.service.flush()
  expect(h.saved()).toEqual({ [poster]: "apple", [background]: "deezer" })
  const url =
    "image://localhost/ext/img?src=https%3A%2F%2Fsynthetic.test%2Fcover&scope=a&revision=existing"
  store.getState().rememberRevision("a", url, "poster-only")
  expect(
    store.getState().revisions[artworkRevisionKey("a", url, "background")!]
  ).toBeUndefined()
  store.getState().rememberRevision("a", url, "background-only", "background")
  expect(store.getState().revisions[artworkRevisionKey("a", url)!]).toBe(
    "poster-only"
  )
  expect(
    store.getState().revisions[artworkRevisionKey("a", url, "background")!]
  ).toBe("background-only")
  expect(applyArtworkRevision(url, undefined)).toBe(url)
})

test("late legacy hydration preserves individual candidate intent and source Automatic clears it durably", async () => {
  const key = artworkPreferenceKey("a", "album", "Artist", "Album")!
  const h = harness({ [key]: "apple" })
  h.delay()
  const store = h.create()
  store.getState().setCandidate(key, "fanart", "verified-poster-2")
  h.barrier.resolve(
    JSON.stringify({ state: { choices: { [key]: "apple" } }, version: 0 })
  )
  await settle()
  await h.service.flush()
  expect(store.getState().choices[key]).toBe("fanart")
  expect(h.savedState().candidateChoices[key]).toEqual({
    source: "fanart",
    id: "verified-poster-2",
  })
  store.getState().setChoice(key, null)
  await settle()
  await h.service.flush()
  expect(h.savedState().candidateChoices[key]).toBeNull()
})
