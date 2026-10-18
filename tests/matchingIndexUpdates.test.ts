import { expect, test } from "bun:test"
import { createMatchingChangePump } from "../src/matching/changePump"
import type { MatchingChanges } from "../src/matching/resolverTypes"
import { deferred } from "./helpers/radioAudioFakes"
const snapshot = (cursor = 0, changes: MatchingChanges["changes"] = []): MatchingChanges => ({ revision: cursor, cursor, reset: false, coverage: "complete", changes })

test("matching notifications coalesce and initialize from a native head reset", async () => {
  let calls = 0
  const updates: MatchingChanges[] = []
  const pump = createMatchingChangePump({ current: () => true, delay: 0,
    read: async cursor => { calls++; expect(cursor).toBe(Number.MAX_SAFE_INTEGER); return { ...snapshot(50), reset: true } },
    publish: update => updates.push(update),
  })
  for (let index = 0; index < 100; index++) pump.offer()
  await Bun.sleep(10)
  pump.stop()
  expect(calls).toBe(1)
  expect(updates.length).toBe(1)
  expect(updates[0].reset).toBe(true)
})

test("matching change tails stay bounded and continue after three pages without replaying old cursors", async () => {
  let calls = 0
  const updates: MatchingChanges[] = []
  const pump = createMatchingChangePump({ current: () => true, delay: 0,
    read: async cursor => {
      calls++
      if (cursor === Number.MAX_SAFE_INTEGER) return { ...snapshot(0), reset: true }
      const end = Math.min(800, cursor + 200)
      return { ...snapshot(end), revision: 800, changes: Array.from({ length: end - cursor }, (_, index) => ({ sequence: cursor + index + 1, kind: "track", id: cursor + index + 1 })) }
    }, publish: update => updates.push(update),
  })
  pump.offer(); await Bun.sleep(10)
  pump.offer(); await Bun.sleep(20); pump.stop()
  expect(calls).toBe(5)
  expect(updates[1].changes.length).toBe(600)
  expect(updates[2].changes.length).toBe(200)
  expect(updates[2].cursor).toBe(800)
})

test("retired native change reads cannot refresh a replacement library", async () => {
  let current = true, published = 0
  const pending = deferred<MatchingChanges>()
  const pump = createMatchingChangePump({ current: () => current, delay: 0, read: () => pending.promise, publish: () => published++ })
  pump.offer(); await Bun.sleep(5)
  current = false
  pending.resolve({ ...snapshot(5), reset: true })
  await Bun.sleep(5); pump.stop()
  expect(published).toBe(0)
})

test("failed change reads back off and disposal cancels their retry", async () => {
  let calls = 0
  const pump = createMatchingChangePump({ current: () => true, delay: 0, read: async () => { calls++; throw Error("storage unavailable") }, publish: () => { throw Error("must not publish a failed read") } })
  pump.offer(); await Bun.sleep(20)
  expect(calls).toBe(1)
  pump.stop(); await Bun.sleep(5)
  expect(calls).toBe(1)
})
