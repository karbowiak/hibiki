import { expect, test } from "bun:test"
import { ScopedPersistence } from "../src/stores/scopedPersistence"
import { providerCacheScope } from "../src/lib/providerCacheScope"
import { buildPlexImageUrl, buildPlexExternalImageUrl } from "../src/backends/plex/imageUrl"
import { deferred, settle } from "./helpers/radioAudioFakes"

function memory() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: async (key: string) => {
      values.delete(key)
    }
  }
}

test("provider scopes use the same SHA-256 tuple as native and separate account/server/library/endpoints", async () => {
  const scope = await providerCacheScope("plex", "server", "dummy-token", "music", "https://plex.test")
  const expected = "plex-0792f0fa6f74358dbdacfac79e241543d63725c9b7e26f8c64b5c6e5f7814358"
  expect(scope).toBe(expected)
  expect(scope).not.toContain("dummy-token")
  const variants = [
    ["other-server", "dummy-token", "music", "https://plex.test"],
    ["server", "other-token", "music", "https://plex.test"],
    ["server", "dummy-token", "other-library", "https://plex.test"],
    ["server", "dummy-token", "music", "https://other.test"]
  ]
  for (const tuple of variants)
    expect(await providerCacheScope("plex", ...(tuple as [string, string, string, string]))).not.toBe(scope)
})

test("late hydration cannot return one account's saved state under a different scope", async () => {
  const old = deferred<string | null>(),
    storage = memory()
  const cache = new ScopedPersistence(
    { ...storage, getItem: (key) => (key.endsWith(":old") ? old.promise : storage.getItem(key)) },
    "library"
  )
  const first = cache.activate("old")
  await settle()
  await cache.activate("new")
  old.resolve(JSON.stringify({ version: 2, scope: "old", state: { playlists: ["old-private"] } }))
  expect(await first).toBeUndefined()
  cache.save({ playlists: ["new-private"] })
  await cache.flush()
  expect([...storage.values.keys()]).toEqual(["library:new"])
})

test("cache writes stay ordered and pending snapshots coalesce to the newest state", async () => {
  const first = deferred<void>(),
    storage = memory(),
    written: number[] = []
  const cache = new ScopedPersistence(
    {
      ...storage,
      setItem: async (key, value) => {
        const revision = JSON.parse(value).state.revision
        written.push(revision)
        if (revision === 1) await first.promise
        await storage.setItem(key, value)
      }
    },
    "library"
  )
  await cache.activate("account")
  cache.save({ revision: 1 })
  cache.save({ revision: 2 })
  cache.save({ revision: 3 })
  const reconnect = cache.activate("account")
  await settle()
  first.resolve()
  expect(await reconnect).toEqual({ revision: 3 })
  expect(written).toEqual([1, 3])
})

test("disconnect suspends persistence without deleting stored account data", async () => {
  const storage = memory(),
    cache = new ScopedPersistence(storage, "library")
  await cache.activate("account")
  cache.save({ mixes: ["keep"] })
  await cache.flush()
  await cache.activate(null)
  cache.save({ mixes: [] })
  await cache.flush()
  expect(await cache.activate("account")).toEqual({ mixes: ["keep"] })
})

test("malformed or wrong-scope caches and storage failures do not block playback", async () => {
  const storage = memory()
  storage.values.set("library:account", "broken-json")
  const cache = new ScopedPersistence(storage, "library")
  expect(await cache.activate("account")).toBeUndefined()
  storage.values.set(
    "library:account",
    JSON.stringify({ version: 2, scope: "other", state: { token: "wrong" } })
  )
  expect(await cache.activate("account")).toBeUndefined()
  const unavailable = new ScopedPersistence(
    {
      ...storage,
      getItem: async () => {
        throw new Error("Read failed")
      },
      setItem: async () => {
        throw new Error("Write failed")
      }
    },
    "library"
  )
  await unavailable.activate("account")
  unavailable.save({ mixes: [] })
  await unavailable.flush()
})

test("artwork URLs contain an opaque scope and no Plex token, while preserving proxy paths and signed query bytes", () => {
  const value = buildPlexImageUrl(
    "https://plex.test/plex/",
    "dummy-secret",
    "album",
    "../unsafe/id",
    "/library/image?width=400",
    "Album",
    "Artist",
    "opaque-scope"
  )!
  const url = new URL(value),
    src = url.searchParams.get("src")!
  expect(src).toBe("https://plex.test/plex/library/image?width=400")
  expect(url.searchParams.get("scope")).toBe("opaque-scope")
  expect(url.pathname).toBe("/ext/img")
  expect(value).not.toContain("dummy-secret")
  const signed = buildPlexImageUrl(
    "https://plex.test",
    "dummy-secret",
    "artist",
    "1",
    "https://cdn.test/image?signature=a%20b%2Bc&X-Plex-Token=dummy-secret",
    "Artist"
  )!
  expect(new URL(signed).searchParams.get("src")).toBe("https://cdn.test/image?signature=a%20b%2Bc")
  const external = buildPlexExternalImageUrl(
    "https://plex.test",
    "dummy-secret",
    "https://cdn.test/cover.png",
    "opaque-scope"
  )!
  expect(new URL(external).searchParams.get("src")).toBe("https://cdn.test/cover.png")
})

test("clearing a cache during hydration retires that read and persists the cleared snapshot", async () => {
  const loaded = deferred<string | null>(),
    storage = memory()
  const cache = new ScopedPersistence({ ...storage, getItem: () => loaded.promise }, "library")
  const reading = cache.activate("account")
  await settle()
  cache.cancelHydration()
  cache.save({ artists: {} })
  await cache.flush()
  loaded.resolve(JSON.stringify({ version: 2, scope: "account", state: { artists: { old: "private" } } }))
  expect(await reading).toBeUndefined()
  expect(JSON.parse(storage.values.get("library:account")!).state).toEqual({ artists: {} })
})
