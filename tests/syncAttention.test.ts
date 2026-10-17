import { expect, test } from "bun:test"
import { emptyFavorites } from "../src/favorites/model"
import {
  favoritesNeedReview,
  playlistNeedsReview,
} from "../src/lib/syncAttention"
import {
  claimScrobbleNotice,
  SCROBBLE_NOTICE_DELAY_MS,
} from "../src/lib/scrobbleNotice"
import type { LinkedPlaylist } from "../src/playlistSync/linked"

test("likes keep matching and enabled connection problems on their Sync control", () => {
  const collection = emptyFavorites()
  expect(favoritesNeedReview(collection, {})).toBe(false)
  expect(favoritesNeedReview(collection, { lastfm: "Disconnected" })).toBe(
    false
  )
  collection.settings.lastfm = true
  expect(favoritesNeedReview(collection, { lastfm: "Disconnected" })).toBe(true)
  collection.entries["one"] = {
    id: "one",
    key: "one",
    title: "Song",
    artist: "Artist",
    liked: true,
    explicit: false,
    sources: {},
    changedAt: 1,
    localTrackIds: [],
  }
  expect(favoritesNeedReview(collection, {})).toBe(true)
  collection.entries.one.localTrackIds = ["1"]
  expect(favoritesNeedReview(collection, {})).toBe(false)
  collection.settings.listenbrainz = true
  expect(favoritesNeedReview(collection, {})).toBe(true)
  collection.entries.one.recordingMbid = "recording"
  expect(favoritesNeedReview(collection, {})).toBe(false)
})

test("playlist review indicators cover errors, retained writes and unmatched results, not active work", () => {
  const link = {
    state: "ready",
    paused: false,
    enabled: true,
  } as LinkedPlaylist
  expect(playlistNeedsReview(undefined)).toBe(false)
  expect(playlistNeedsReview(link)).toBe(false)
  expect(
    playlistNeedsReview({
      ...link,
      incomplete: { matchingDone: false, missingOccurrenceIds: ["one"] } as any,
    })
  ).toBe(false)
  expect(
    playlistNeedsReview({
      ...link,
      incomplete: { matchingDone: true, missingOccurrenceIds: ["one"] } as any,
    })
  ).toBe(true)
  for (const state of ["error", "unknown", "conflict"] as const)
    expect(playlistNeedsReview({ ...link, state })).toBe(true)
  expect(
    playlistNeedsReview({ ...link, paused: true, pauseReason: "manual" })
  ).toBe(false)
  expect(playlistNeedsReview(link, true)).toBe(true)
  expect(playlistNeedsReview(link, false, true)).toBe(true)
  expect(
    playlistNeedsReview({ ...link, job: { step: { state: "unknown" } } as any })
  ).toBe(true)
})

test("a day-long scrobbling outage notifies once across restarts and cannot spam as its backlog changes", () => {
  let value: string | null = null
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next
    },
  }
  const since = 100000,
    now = since * 1000 + SCROBBLE_NOTICE_DELAY_MS
  expect(claimScrobbleNotice(since, now - 1, storage)).toBe(false)
  expect(claimScrobbleNotice(since, now, storage)).toBe(true)
  expect(
    claimScrobbleNotice(since, now + SCROBBLE_NOTICE_DELAY_MS, storage)
  ).toBe(false)
  expect(claimScrobbleNotice(since + 1, now + 1000, storage)).toBe(false)
  expect(
    claimScrobbleNotice(since + 1, now + SCROBBLE_NOTICE_DELAY_MS, storage)
  ).toBe(true)
  expect(claimScrobbleNotice(0, now, storage)).toBe(false)
  expect(claimScrobbleNotice(Number.NaN, now, storage)).toBe(false)
  expect(claimScrobbleNotice(since, now, { getItem: () => { throw Error("unavailable storage") }, setItem: () => {} })).toBe(true)
})
