import { expect, test } from "bun:test"
import {
  watchCatalogueUpdates,
  createCatalogueRefreshQueue,
  metadataRefreshAffectsPage,
  type CatalogueCommittedUpdate,
} from "../src/offline/catalogueUpdates"
import { deferred, settle } from "./helpers/radioAudioFakes"

function fixture() {
  const context = {
    cacheScope: `plex-${"a".repeat(64)}`,
    connectionRevision: 7,
  }
  let receive!: (update: CatalogueCommittedUpdate) => void,
    current = true,
    cancelled = 0
  const registration = deferred<() => void>(),
    timers = new Map<number, () => void>(),
    updates: CatalogueCommittedUpdate[] = []
  let serial = 0
  const stop = watchCatalogueUpdates(
    context,
    () => current,
    (update) => updates.push(update),
    (handler) => {
      receive = handler
      return registration.promise
    },
    {
      setTimeout(callback) {
        const id = ++serial
        timers.set(id, callback)
        return id as any
      },
      clearTimeout(id) {
        timers.delete(id as any)
      },
    }
  )
  const event = (
    changesRevision: number,
    extra: Partial<CatalogueCommittedUpdate> = {}
  ) => ({ ...context, changesRevision, ...extra })
  return {
    context,
    updates,
    event,
    stop,
    send: (event: CatalogueCommittedUpdate) => receive(event),
    registered: () => registration.resolve(() => cancelled++),
    retire: () => {
      current = false
    },
    cancelled: () => cancelled,
    flush: () => {
      for (const [id, callback] of timers) {
        timers.delete(id)
        callback()
      }
    },
  }
}

test("committed catalogue updates coalesce newer revisions and fence scope/connection identity", async () => {
  const f = fixture()
  await settle()
  f.registered()
  await settle()
  f.send(f.event(1, { cacheScope: `plex-${"b".repeat(64)}` }))
  f.send(f.event(2, { connectionRevision: 8 }))
  f.send(f.event(Number.NaN))
  f.send(f.event(3, { items: [{ kind: "track", id: 42 }] }))
  f.send(
    f.event(4, {
      items: [
        { kind: "track", id: 42 },
        { kind: "artist", id: 8 },
      ],
    })
  )
  expect(f.updates).toEqual([])
  f.flush()
  expect(f.updates).toEqual([
    f.event(4, {
      items: [
        { kind: "track", id: 42 },
        { kind: "artist", id: 8 },
      ],
    }),
  ])
  f.send(f.event(2))
  f.flush()
  expect(f.updates).toHaveLength(1)
  f.send(f.event(5))
  f.retire()
  f.flush()
  expect(f.updates).toHaveLength(1)
  f.stop()
  expect(f.cancelled()).toBe(1)
})

test("retirement cancels pending UI work and late listener registration", async () => {
  const f = fixture()
  await settle()
  f.send(f.event(1))
  f.stop()
  f.flush()
  expect(f.updates).toEqual([])
  f.registered()
  await settle()
  expect(f.cancelled()).toBe(1)
  f.send(f.event(2))
  f.flush()
  expect(f.updates).toEqual([])
})

test("failed event registration leaves the progress-polling fallback usable", async () => {
  const stop = watchCatalogueUpdates(
    { cacheScope: "scope", connectionRevision: 1 },
    () => true,
    () => {
      throw Error("Unexpected publication")
    },
    () => {
      throw Error("Event bridge unavailable")
    }
  )
  await settle()
  expect(stop).not.toThrow()
})

function refreshClock() {
  let time = 0,
    serial = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => time,
    setTimeout(run: () => void, delay: number) {
      const id = ++serial
      timers.set(id, { at: time + delay, run })
      return id as any
    },
    clearTimeout(id: any) {
      timers.delete(id)
    },
    pending: () => timers.size,
    async advance(ms: number) {
      const end = time + ms
      for (let i = 0; i < 1000; i++) {
        const next = [...timers]
          .filter(([, job]) => job.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next) {
          time = end
          await settle()
          return
        }
        time = next[1].at
        timers.delete(next[0])
        next[1].run()
        await settle()
      }
      throw Error("Unbounded catalogue refresh timer loop")
    },
  }
}

test("committed refreshes serialize slow reads and coalesce events with polling", async () => {
  const clock = refreshClock(),
    first = deferred<void>(),
    starts: number[] = []
  const queue = createCatalogueRefreshQueue(
    () => true,
    async () => {
      starts.push(clock.now())
      if (starts.length === 1) await first.promise
    },
    clock
  )
  queue.baseline(10)
  queue.offer(10)
  await clock.advance(0)
  expect(starts).toEqual([])
  queue.offer(11)
  await clock.advance(0)
  for (let revision = 12; revision <= 100; revision++) queue.offer(revision)
  queue.offer(100) // polling sees the same commit as the native event
  await clock.advance(30_000)
  expect(starts).toEqual([0])
  first.resolve()
  await settle()
  await clock.advance(0)
  expect(starts).toEqual([0, 30_000])
  queue.offer(100)
  queue.offer(99)
  await clock.advance(60_000)
  expect(starts).toHaveLength(2)
  queue.stop()
})

test("a full day of incremental bursts stays bounded and idle between changes", async () => {
  const clock = refreshClock(),
    starts: number[] = []
  const queue = createCatalogueRefreshQueue(
    () => true,
    async () => {
      starts.push(clock.now())
    },
    clock
  )
  let revision = 1
  queue.baseline(revision)
  for (let hour = 0; hour < 24; hour++) {
    for (let second = 0; second < 60; second++) {
      queue.offer(++revision)
      queue.offer(revision)
      await clock.advance(1000)
    }
    await clock.advance(3_540_000)
    expect(clock.pending()).toBe(0)
    const count = starts.length
    queue.offer(revision)
    await clock.advance(0)
    expect(starts).toHaveLength(count)
  }
  expect(starts).toHaveLength(24 * 7)
  expect(starts.slice(1).every((time, i) => time - starts[i]! >= 10_000)).toBe(
    true
  )
  queue.stop()
})

test("failed refreshes recover, pending offline work resumes and retirement cancels work", async () => {
  const clock = refreshClock()
  let owned = true,
    calls = 0
  const queue = createCatalogueRefreshQueue(
    () => owned,
    async () => {
      calls++
      if (calls === 1) throw Error("Temporary read failure")
    },
    clock
  )
  queue.offer(1)
  await clock.advance(0)
  queue.offer(2)
  owned = false
  await clock.advance(10_000)
  expect(calls).toBe(1)
  owned = true
  queue.offer(2)
  await clock.advance(0)
  expect(calls).toBe(2)
  queue.offer(3)
  queue.stop()
  await clock.advance(60_000)
  queue.offer(4)
  await clock.advance(0)
  expect(calls).toBe(2)
  expect(clock.pending()).toBe(0)
})

test("revalidated metadata refreshes only its visible entity and merged album copies", () => {
  expect(metadataRefreshAffectsPage("getArtist", ["8"], "/artist/8")).toBe(true)
  expect(
    metadataRefreshAffectsPage(
      "getArtistAlbumsInSection",
      ["8", "7"],
      "/artist/8"
    )
  ).toBe(true)
  expect(
    metadataRefreshAffectsPage("getRelatedHubs", ["8"], "/artist/8/")
  ).toBe(true)
  expect(metadataRefreshAffectsPage("getArtist", ["9"], "/artist/8")).toBe(
    false
  )
  expect(metadataRefreshAffectsPage("getAlbum", ["8"], "/artist/8")).toBe(false)
  expect(
    metadataRefreshAffectsPage("getAlbumTracks", ["9"], "/album/8", ["9"])
  ).toBe(true)
  expect(metadataRefreshAffectsPage("getAlbum", ["9"], "/album/8")).toBe(false)
  for (const path of ["/", "/library", "/playlist/8", "/search"])
    expect(metadataRefreshAffectsPage("getArtist", ["8"], path)).toBe(false)
  expect(
    metadataRefreshAffectsPage(
      "getItemsByTag",
      ["genre", "pop"],
      "/genre/genre/pop"
    )
  ).toBe(true)
})
