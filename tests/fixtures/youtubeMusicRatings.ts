import assert from "node:assert/strict"
import { mock } from "bun:test"
import { create } from "zustand"
import { youtubeMusicTrack } from "../../src/backends/ytmusic/tracks"
import { deferred } from "../helpers/radioAudioFakes"
const scenario = process.argv[2], disk = new Map<string, unknown>()
mock.module("idb-keyval", () => ({ createStore: () => ({}), get: async (key: string) => structuredClone(disk.get(key)),
  update: async (key: string, change: (old: unknown) => unknown) => { disk.set(key, structuredClone(change(disk.get(key)))) } }))
const track = youtubeMusicTrack({ videoId: "a1234567890", title: "Song", artist: "Artist", album: "Album", duration: "3:00", thumbnail: null })
let owner = "A", revision = 0, failPlex = scenario === "restart"
const ytWrites: boolean[] = [], plexWrites: (number | null)[] = [], remoteWrites: { service: string; liked: boolean }[] = []
const first = deferred(), matching = deferred(), feedback = { lastfm: false, listenbrainz: false }
const provider = { cacheScope: "P", playbackSession: {}, isOffline: false,
  resolvePlaylistRecording: async () => ({ status: "verified", recordingMbid: "00000000-0000-4000-8000-000000000000" }) }
let matchCalls = 0
mock.module("../../src/mixedPlaylists/counterparts", () => ({
  captureMusicOwner: () => { const captured = revision; return { owners: { ytmusic: owner, plex: "P" }, provider, current: () => captured === revision } },
  resolveCounterpart: async () => { matchCalls++; if (scenario === "matching" && matchCalls === 1) await matching.promise; return { status: "matched", track: { ...track, id: "42" } } },
}))
mock.module("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  if (command !== "ytmusic_set_song_like") throw Error(`Unexpected ${command}`)
  assert.equal(args.expectedAccount, owner)
  ytWrites.push(args.liked)
  if (scenario === "latest" && ytWrites.length === 1) await first.promise
} }))
const likes = create(() => ({ owner: 1, entries: {}, mutation: 0 }))
mock.module("../../src/backends/ytmusic/likes", () => ({ useYoutubeMusicLikesStore: likes }))
const auth = { isAuthenticated: scenario === "thresholds", isEnabled: true, username: "User" }
mock.module("../../src/metadata/lastfm/authStore", () => ({ useLastfmStore: create(() => auth) }))
mock.module("../../src/metadata/listenbrainz/authStore", () => ({ useListenBrainzStore: create(() => auth) }))
mock.module("../../src/favorites/native", () => ({ favoritesRemote: {
  account: async (service: string) => ({ service, user: "User", revision: "one" }),
  peek: async (account: any) => feedback[account.service],
  set: async (account: any, _record: any, liked: boolean) => { remoteWrites.push({ service: account.service, liked }); feedback[account.service] = liked; return liked },
} }))
mock.module("../../src/stores/favoritesStore", () => ({ useFavoritesStore: create(() => ({
  loaded: true, provider, session: provider.playbackSession,
  ratingChanged: async (_id: string, _title: string, _artist: string, value: number | null) => ({ value }),
})) }))
mock.module("../../src/favorites/saveRating", () => ({ saveTrackRatingToPlex: async (_provider: unknown, intent: any) => {
  if (failPlex) throw Error("Plex unavailable; rating retained")
  plexWrites.push(intent.value)
} }))
const { useYoutubeMusicRatingsStore: store, youtubeRatingLiked, scrobbleRatingLoved } = await import("../../src/backends/ytmusic/ratings")
const wait = async (condition: () => boolean) => { for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(1); assert.ok(condition()) }
await store.getState().load(owner)
if (scenario === "thresholds") {
  assert.deepEqual([2, 4, 6, 8, 10, null].map(youtubeRatingLiked), [false, true, true, true, true, false])
  assert.deepEqual([2, 4, 6, 8, 10, null].map(scrobbleRatingLoved), [false, false, true, true, true, false])
  for (const value of [2, 4, 6, 10, null]) {
    await store.getState().rate(track, value)
    await wait(() => store.getState().entries[track.id]?.saved.listenbrainz === "User")
    assert.equal(store.getState().entries[track.id].value, value)
  }
  assert.deepEqual(ytWrites, [false, true, true, true, false])
  assert.deepEqual(plexWrites, [2, 4, 6, 10, null])
  assert.deepEqual(remoteWrites, [ { service: "lastfm", liked: true }, { service: "listenbrainz", liked: true },
    { service: "lastfm", liked: false }, { service: "listenbrainz", liked: false } ])
} else if (scenario === "latest" || scenario === "matching") {
  await store.getState().rate(track, 10)
  await wait(() => scenario === "latest" ? ytWrites.length === 1 : matchCalls === 1)
  await store.getState().rate(track, 2)
  first.resolve(); matching.resolve()
  await wait(() => store.getState().entries[track.id]?.saved.plex === "P")
  assert.deepEqual(ytWrites, [true, false]); assert.deepEqual(plexWrites, [2])
  assert.equal(store.getState().entries[track.id].value, 2)
} else if (scenario === "restart") {
  await store.getState().rate(track, 4)
  await wait(() => !!store.getState().entries[track.id]?.error)
  store.setState({ owner: null, entries: {}, loaded: false })
  failPlex = false
  await store.getState().load("A")
  await wait(() => store.getState().entries[track.id]?.saved.plex === "P")
  assert.equal(store.getState().entries[track.id].value, 4)
  assert.deepEqual(ytWrites, [true]); assert.deepEqual(plexWrites, [4])
} else if (scenario === "account") {
  await store.getState().rate(track, 8)
  await wait(() => !!store.getState().entries[track.id]?.saved.plex)
  owner = "B"; revision++
  await store.getState().load(owner)
  assert.deepEqual(store.getState().entries, {})
  owner = "A"; revision++
  await store.getState().load(owner)
  assert.equal(store.getState().entries[track.id].value, 8)
  assert.deepEqual(plexWrites, [8])
} else if (scenario === "binary") {
  likes.setState({ entries: { [track.id]: { liked: true } } })
  await store.getState().resume()
  assert.deepEqual(store.getState().entries, {})
  assert.deepEqual(plexWrites, []); assert.deepEqual(ytWrites, [])
}
