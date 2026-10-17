import assert from "node:assert/strict"
import { mock } from "bun:test"
import { create } from "zustand"
import { emptyFavorites, setFavorite, bindFavorites } from "../../src/favorites/model"
import { effectiveTrackRating } from "../../src/favorites/ratings"
import { deferred } from "../helpers/radioAudioFakes"
const scenario = process.argv[2]
const auth = create(() => ({ username: "listener", isAuthenticated: true }))
mock.module("../../src/metadata/lastfm/authStore", () => ({ useLastfmStore: auth }))
mock.module("../../src/metadata/listenbrainz/authStore", () => ({ useListenBrainzStore: auth }))
const published: unknown[][] = []
mock.module("../../src/stores/libraryStore", () => ({ useLibraryStore: { getState: () => ({ onItemRated: (...args: unknown[]) => published.push(args) }) } }))
const account = { service: "lastfm", user: "listener", revision: "lease" }
const reference = { key: "lastfm:original", title: "Song", artist: "Artist", localTrackId: "42", likedAt: 1400000000000 }
let initial = bindFavorites(emptyFavorites(), "lastfm", account)
initial.settings.lastfm = true
initial.bindings.lastfm!.initialized = true
initial = setFavorite(initial, reference, true, false)
initial.entries[reference.key].likedAt = reference.likedAt
initial.entries[reference.key].sources.lastfm = { key: reference.key, liked: true, desired: true, likedAt: reference.likedAt }
let metadata: any = { version: 1, settings: { ...initial.settings, ratingThreshold: 10 }, bindings: initial.bindings, ratingsImported: true }
let revision = 0
const rows = structuredClone(initial.entries)
let remoteLiked = true, serviceWrites = 0
mock.module("../../src/favorites/native", () => ({ favoritesRemote: {
  account: async () => account,
  page: async (_account: unknown, offset: number) => ({ rows: remoteLiked ? [reference] : [], total: remoteLiked ? 1 : 0, offset }),
  peek: async () => remoteLiked,
  set: async (_account: unknown, _row: unknown, liked: boolean) => { serviceWrites++; remoteLiked = liked; return liked },
} }))
const native = {
  load: async () => ({ metadata: structuredClone(metadata), revision, total: Object.keys(rows).length }),
  page: async () => Object.values(rows).map(payload => ({ id: payload.id, payload: structuredClone(payload) })),
  save: async (expected: number, next: unknown, entries: any[]) => { assert.equal(expected, revision); metadata = structuredClone(next); for (const row of entries) rows[row.id] = structuredClone(row.payload); return ++revision },
}
const writes: Array<number | null> = []
const first = deferred<void>()
const provider: any = { name: "Plex", cacheScope: "scope", playbackSession: {}, favorites: native, isOffline: false,
  capabilities: { ratings: true }, getTrack: async () => { throw Error("No extra lookup expected") },
  rate: async (_id: string, value: number | null) => { writes.push(value); if (scenario === "race" && writes.length === 1) await first.promise },
}
const { useProviderStore } = await import("../../src/stores/providerStore")
useProviderStore.getState().setProvider(provider)
const { useFavoritesStore } = await import("../../src/stores/favoritesStore")
const { saveTrackRatingToPlex } = await import("../../src/favorites/saveRating")
const store = () => useFavoritesStore.getState()
await store().load()
assert.equal(metadata.ratingModel, 1)
assert.equal(metadata.settings.ratingThreshold, 6)
assert.equal(metadata.ratingsImported, false)
assert.equal(rows[reference.key].likedAt, reference.likedAt)
assert.equal(effectiveTrackRating(null, store().ratingsByTrackId.get("42")), 6)
assert.deepEqual(writes, [])
if (scenario === "race") {
  const older = await store().ratingChanged("42", "Song", "Artist", 10)
  const writing = saveTrackRatingToPlex(provider, older)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.deepEqual(writes, [10])
  const newer = await store().ratingChanged("42", "Song", "Artist", 2)
  const waiting = saveTrackRatingToPlex(provider, newer)
  first.resolve()
  await Promise.all([writing, waiting])
  assert.deepEqual(writes, [10, 2])
  assert.equal(rows[reference.key].rating!.id, newer.id)
  assert.equal(rows[reference.key].rating!.plexSaved, true)
  assert.equal(rows[reference.key].liked, false)
  const retired = await store().ratingChanged("42", "Song", "Artist", 8)
  const session = provider.playbackSession
  provider.playbackSession = {}
  await saveTrackRatingToPlex(provider, retired, session)
  assert.deepEqual(writes, [10, 2])
} else {
  const value = scenario === "clear" ? null : 2
  provider.isOffline = true
  const intent = await store().ratingChanged("42", "Song", "Artist", value)
  await assert.rejects(saveTrackRatingToPlex(provider, intent), /saved in Hibiki/)
  assert.deepEqual(writes, [])
  assert.equal(rows[reference.key].liked, false)
  assert.equal(rows[reference.key].rating!.plexSaved, false)
  assert.equal(effectiveTrackRating(10, store().ratingsByTrackId.get("42")), value)
  provider.isOffline = false
  await store().sync()
  assert.equal(remoteLiked, false)
  assert.equal(serviceWrites, 1)
  assert.deepEqual(writes, [], "Like sync must never enter Plex's rating path")
  useFavoritesStore.setState({ loaded: false })
  await store().load()
  assert.equal(effectiveTrackRating(10, store().ratingsByTrackId.get("42")), value)
  assert.deepEqual(writes, [])
  await saveTrackRatingToPlex(provider, intent)
  assert.deepEqual(writes, [value])
  assert.equal(rows[reference.key].rating!.plexSaved, true)
  useFavoritesStore.setState({ loaded: false }); await store().load()
  assert.deepEqual(writes, [value], "Restart must never replay an acknowledged star write")
}
