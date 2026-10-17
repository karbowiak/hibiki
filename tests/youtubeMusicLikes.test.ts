import { expect, test } from "bun:test"
import { createYoutubeMusicLikesStore } from "../src/backends/ytmusic/likes"
import { youtubeMusicTrack } from "../src/backends/ytmusic/tracks"
import { deferred } from "./helpers/radioAudioFakes"
import type { YoutubeMusicItem } from "../src/backends/ytmusic/discovery"

const song = (liked: boolean): YoutubeMusicItem => ({ id: "abcdefghijk", kind: "song", title: "Song", artist: "Artist",
  album: null, duration: "3:00", thumbnail: null, year: null, liked })
const track = youtubeMusicTrack({ videoId: "abcdefghijk", title: "Song", artist: "Artist", album: null, duration: "3:00", thumbnail: null })

test("likes are optimistic, shared, and cannot be overwritten by old catalog data", async () => {
  const pending = deferred<void>(), writes: boolean[] = []
  const store = createYoutubeMusicLikesStore({ read: async () => false, write: async (_id, liked) => {
    writes.push(liked); await pending.promise
  } })
  store.getState().connect(1)
  store.getState().observe([song(false)])
  const work = store.getState().toggle(track)
  await Promise.resolve()
  expect(store.getState().entries[track.id].liked).toBe(true)
  expect(store.getState().entries[track.id].saving).toBe(true)
  expect(await store.getState().toggle(track)).toBe(false)
  store.getState().observe([song(false)])
  expect(store.getState().entries[track.id].liked).toBe(true)
  expect(writes).toEqual([true])
  pending.resolve()
  expect(await work).toBe(true)
  expect(store.getState().entries[track.id].saving).toBe(false)
  store.getState().observe([song(false)], 0, true)
  expect(store.getState().entries[track.id].liked).toBe(true)
})

test("a rejected unlike restores the previous like and can be retried", async () => {
  let fail = true
  const store = createYoutubeMusicLikesStore({ read: async () => true, write: async () => { if (fail) throw Error("Unavailable") } })
  store.getState().connect(1)
  store.getState().observe([song(true)])
  expect(await store.getState().toggle(track)).toBe(false)
  expect(store.getState().entries[track.id].liked).toBe(true)
  expect(store.getState().entries[track.id].saving).toBe(false)
  expect(store.getState().entries[track.id].error).toContain("Unavailable")
  fail = false
  expect(await store.getState().toggle(track)).toBe(true)
  expect(store.getState().entries[track.id].liked).toBe(false)
})

test("unknown state is checked before deciding whether to like or unlike", async () => {
  const writes: boolean[] = []
  const store = createYoutubeMusicLikesStore({ read: async () => true, write: async (_id, liked) => { writes.push(liked) } })
  store.getState().connect(1)
  expect(await store.getState().toggle(track)).toBe(true)
  expect(writes).toEqual([false])
})

test("an account change retires pending checks and never sends their writes", async () => {
  const pending = deferred<boolean>(), writes: boolean[] = []
  const store = createYoutubeMusicLikesStore({ read: () => pending.promise, write: async (_id, liked) => { writes.push(liked) } })
  store.getState().connect(1)
  const work = store.getState().toggle(track)
  store.getState().connect(null)
  store.getState().connect(2)
  pending.resolve(true)
  expect(await work).toBe(false)
  expect(store.getState().entries).toEqual({})
  expect(writes).toEqual([])
})

test("changing another song does not discard an unrelated pending status check", async () => {
  const pending = deferred<boolean>()
  const store = createYoutubeMusicLikesStore({ read: () => pending.promise, write: async () => {} })
  store.getState().connect(1)
  store.getState().observe([song(false)])
  const other = { ...track, id: "ytmusic:lmnopqrstuv", streamUrl: "ytmusic:lmnopqrstuv" }
  const check = store.getState().check(other)
  expect(await store.getState().toggle(track)).toBe(true)
  pending.resolve(true)
  expect(await check).toBe(true)
  expect(store.getState().entries[other.id].checking).toBe(false)
  expect(store.getState().entries[other.id].liked).toBe(true)
})
