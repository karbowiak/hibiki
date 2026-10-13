import { expect, test } from "bun:test"
import {
  watchCatalogueUpdates,
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
