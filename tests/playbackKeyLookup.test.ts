import { expect, test } from "bun:test"
import { PlaybackKeyLookup } from "../src/audio/playbackKeyLookup"

test("canonical Plex keys use exact fallback without accumulating reverse entries", () => {
  const keys = new PlaybackKeyLookup()
  for (let key = 1; key <= 20000; key++) keys.set(key, String(key))
  expect(keys.size).toBe(0)
  expect(keys.get(19999) ?? String(19999)).toBe("19999")
  keys.set(1, "custom-positive-id")
  expect(keys.get(1)).toBe("custom-positive-id")
})

test("repeated long episode visits stay bounded and retain active outgoing/preload identities", () => {
  const protectedKeys = new Set([-1, -2, -3, 99])
  const keys = new PlaybackKeyLookup(() => protectedKeys)
  for (const key of protectedKeys) keys.set(key, `owned-${key}`)
  for (let visit = 4; visit < 20000; visit++) keys.set(-visit, `podcast-${visit}-${"long-guid".repeat(1000)}`)
  expect(keys.size).toBeLessThanOrEqual(256)
  expect(keys.estimatedIdBytes).toBeLessThanOrEqual(1024 * 1024)
  expect(keys.get(-1)).toBe("owned--1")
  expect(keys.get(-2)).toBe("owned--2")
  expect(keys.get(-3)).toBe("owned--3")
  expect(keys.get(99)).toBe("owned-99")
  expect(keys.get(-4)).toBeUndefined()
})

test("LRU reads retain recent unowned keys and released long ownership becomes evictable", () => {
  const protectedKeys = new Set([-1])
  const keys = new PlaybackKeyLookup(() => protectedKeys, 3, 100)
  keys.set(-1, "a".repeat(100)) // owned string already retained by playback
  keys.set(-2, "b")
  expect(keys.get(-1)).toBe("a".repeat(100))
  protectedKeys.clear()
  keys.trim()
  expect(keys.estimatedIdBytes).toBeLessThanOrEqual(100)
  const small = new PlaybackKeyLookup(() => new Set(), 3)
  for (const key of [-1, -2, -3]) small.set(key, String(key))
  small.get(-1)
  small.set(-4, "four")
  expect(small.get(-1)).toBe("-1")
  expect(small.get(-2)).toBeUndefined()
  expect(small.get(-4)).toBe("four")
  small.clearUnowned()
  expect(small.size).toBe(0)
})
