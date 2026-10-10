import { expect, test } from "bun:test"
import { createRecentPlaylists } from "../src/lib/recentPlaylists"
import type { MusicProvider } from "../src/providers/types"
function harness() {
  let provider = { cacheScope: "account-a" } as MusicProvider
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    }
  }
  const recent = createRecentPlaylists({ getProvider: () => provider, getStorage: () => storage })
  return {
    recent,
    values,
    provider: () => provider,
    switchTo: (scope: string) => {
      provider = { cacheScope: scope } as MusicProvider
    }
  }
}

test("recent playlist shortcuts belong to one account/library and preserve other scopes", () => {
  const h = harness()
  h.recent.record("a")
  h.switchTo("account-b")
  expect(h.recent.read()).toEqual([])
  h.recent.record("b")
  h.switchTo("account-a")
  expect(h.recent.read()).toEqual(["a"])
})

test("a retired playlist action cannot write recent IDs into the current account", () => {
  const h = harness(),
    old = h.provider()
  h.switchTo("account-b")
  h.recent.record("old", old)
  expect(h.recent.read()).toEqual([])
  expect(h.values.size).toBe(0)
})

test("recent lists sanitize malformed rows, deduplicate and cap shortcuts without adopting legacy data", () => {
  const h = harness()
  h.values.set("plex-recent-playlist-ids", JSON.stringify(["private-old"]))
  expect(h.recent.read()).toEqual([])
  h.values.set(
    "hibiki-recent-playlists-v2:account-a",
    JSON.stringify([null, 1, "a", "a", "b", "c", "d", "e", "f"])
  )
  expect(h.recent.read()).toEqual(["a", "b", "c", "d", "e"])
  h.recent.record("c")
  expect(h.recent.read()).toEqual(["c", "a", "b", "d", "e"])
  expect(h.values.has("plex-recent-playlist-ids")).toBe(true)
})

test("unavailable or full browser storage cannot break a successful playlist action", () => {
  const provider = { cacheScope: "account" } as MusicProvider
  const recent = createRecentPlaylists({
    getProvider: () => provider,
    getStorage: () => ({
      getItem: () => {
        throw new Error("Read failed")
      },
      setItem: () => {
        throw new Error("Quota")
      }
    })
  })
  expect(recent.read()).toEqual([])
  expect(() => recent.record("same")).not.toThrow()
})
