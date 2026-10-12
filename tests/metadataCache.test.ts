import { expect, mock, test } from "bun:test"
import { createMetadataCache, MetadataRequestSuperseded } from "../src/stores/metadataCacheCore"
import type { MusicProvider } from "../src/providers/types"
import type { MusicAlbum, MusicArtist } from "../src/types/music"
import { deferred, settle } from "./helpers/radioAudioFakes"

test("an album edit retires old requests and related artist cards while keeping unrelated cached pages", async () => {
  const stale = deferred<MusicAlbum>(), fresh = deferred<MusicAlbum>()
  let reads = 0
  const h = harness({
    getArtistAlbums: async (id) => id === "affected" ? [album("changed")] : [],
    getAlbum: async (id) => id !== "changed" ? album(id) : ++reads === 1 ? album(id) : reads === 2 ? stale.promise : fresh.promise,
  })
  await h.activate()
  await h.cache.loadArtist("affected")
  const otherArtist = await h.cache.loadArtist("other")
  await h.cache.loadAlbum("changed")
  const otherAlbum = await h.cache.loadAlbum("keep")
  const old = h.cache.loadAlbum("changed", { force: true }).catch(error => error)
  h.cache.invalidate("album", "changed")
  expect(h.cache.getArtist("affected")).toBeUndefined()
  expect(h.cache.getArtist("other")).toBe(otherArtist)
  expect(h.cache.getAlbum("keep")).toBe(otherAlbum)
  const latest = h.cache.loadAlbum("changed")
  stale.resolve(album("changed", "Stale"))
  expect(await old).toBeInstanceOf(MetadataRequestSuperseded)
  fresh.resolve(album("changed", "Saved"))
  expect((await latest).album.title).toBe("Saved")
  expect(h.cache.getAlbum("changed")?.album.title).toBe("Saved")
})

const artist = (id: string, title = id) => ({ id, title }) as MusicArtist
const album = (id: string, title = id) =>
  ({ id, title, artistName: "Artist", format: null, year: 2026, trackCount: 1 }) as MusicAlbum
function harness(overrides: Partial<MusicProvider> = {}) {
  const values = new Map<string, string>()
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: async (key: string) => {
      values.delete(key)
    }
  }
  const make = (scope: string, overrides: Partial<MusicProvider> = {}) =>
    ({
      cacheScope: scope,
      getArtist: mock(async (id) => artist(id)),
      getArtistAlbums: mock(async () => []),
      getArtistPopularTracks: mock(async () => []),
      getArtistSimilar: mock(async () => []),
      getRelatedHubs: mock(async () => []),
      getAlbum: mock(async (id) => album(id)),
      getAlbumTracks: mock(async () => []),
      ...overrides
    }) as unknown as MusicProvider
  let provider = make("account-a", overrides)
  const cache = createMetadataCache({ getProvider: () => provider, storage })
  return {
    cache,
    values,
    provider,
    activate: () => cache.activate(provider),
    switchTo: async (scope: string, overrides: Partial<MusicProvider> = {}) => {
      provider = make(scope, overrides)
      await cache.activate(provider)
    }
  }
}

test("a hover prefetch and page request share an in-flight load and cache all page fields", async () => {
  const data = deferred<MusicArtist>()
  const h = harness({
    getArtist: mock(() => data.promise),
    getArtistPopularTracks: mock(
      async () =>
        [
          { id: "track", title: "Track" },
          { id: "track", title: "Track" }
        ] as any
    )
  })
  await h.activate()
  h.cache.prefetchArtist("same")
  const page = h.cache.loadArtist("same")
  expect(h.provider.getArtist).toHaveBeenCalledTimes(1)
  data.resolve(artist("same"))
  const result = await page
  expect(result.popularTracks).toHaveLength(1)
  expect(h.cache.getArtist("same")).toBe(result)
  expect(result.similarArtists).toEqual([])
  expect(result.stations).toEqual([])
})

test("a force refresh supersedes the old hover result and its finally cannot erase the new request", async () => {
  const old = deferred<MusicArtist>(),
    next = deferred<MusicArtist>()
  let calls = 0
  const h = harness({ getArtist: mock(() => (++calls === 1 ? old.promise : next.promise)) })
  await h.activate()
  const first = h.cache.loadArtist("same").catch((error) => error)
  const fresh = h.cache.loadArtist("same", { force: true })
  old.resolve(artist("same", "Old"))
  expect(await first).toBeInstanceOf(MetadataRequestSuperseded)
  const same = h.cache.loadArtist("same")
  expect(calls).toBe(2)
  next.resolve(artist("same", "Fresh"))
  await fresh
  await same
  expect(h.cache.getArtist("same")?.artist.title).toBe("Fresh")
})

test("old artist and album results cannot enter a new account with the same numeric IDs", async () => {
  const oldArtist = deferred<MusicArtist>(),
    oldAlbum = deferred<MusicAlbum>()
  const h = harness({ getArtist: () => oldArtist.promise, getAlbum: () => oldAlbum.promise })
  await h.activate()
  const artistRequest = h.cache.loadArtist("1").catch((error) => error),
    albumRequest = h.cache.loadAlbum("2").catch((error) => error)
  await h.switchTo("account-b", {
    getArtist: async (id) => artist(id, "B artist"),
    getAlbum: async (id) => album(id, "B album")
  })
  await h.cache.loadArtist("1")
  await h.cache.loadAlbum("2")
  oldArtist.resolve(artist("1", "A artist"))
  oldAlbum.resolve(album("2", "A album"))
  expect(await artistRequest).toBeInstanceOf(MetadataRequestSuperseded)
  expect(await albumRequest).toBeInstanceOf(MetadataRequestSuperseded)
  expect(h.cache.getArtist("1")?.artist.title).toBe("B artist")
  expect(h.cache.getAlbum("2")?.album.title).toBe("B album")
})

test("old failure cleanup does not cancel the replacement account's album deduplication", async () => {
  const old = deferred<MusicAlbum>(),
    next = deferred<MusicAlbum>()
  let calls = 0
  const h = harness({ getAlbum: () => old.promise })
  await h.activate()
  const first = h.cache.loadAlbum("same").catch((error) => error)
  await h.switchTo("account-b", {
    getAlbum: () => {
      calls++
      return next.promise
    }
  })
  const fresh = h.cache.loadAlbum("same")
  old.reject(new Error("Old error"))
  await first
  const shared = h.cache.loadAlbum("same")
  expect(calls).toBe(1)
  next.resolve(album("same"))
  await fresh
  await shared
})

test("clearing during prefetch retires outstanding work and allows an immediate new request", async () => {
  const old = deferred<MusicAlbum>()
  let calls = 0
  const h = harness({ getAlbum: async (id) => (++calls === 1 ? old.promise : album(id, "New")) })
  await h.activate()
  const first = h.cache.loadAlbum("same").catch((error) => error)
  const lease = h.cache.capture()
  h.cache.clear()
  expect(h.cache.current(lease)).toBe(false)
  await h.cache.loadAlbum("same")
  old.resolve(album("same", "Old"))
  expect(await first).toBeInstanceOf(MetadataRequestSuperseded)
  expect(h.cache.getAlbum("same")?.album.title).toBe("New")
})

test("disconnect cancels writes and reconnect restores only the matching account/library", async () => {
  const h = harness({ getArtist: async (id) => artist(id, "Private A") })
  await h.activate()
  await h.cache.loadArtist("same")
  h.cache.disconnect()
  expect(h.cache.getArtist("same")).toBeUndefined()
  await h.switchTo("account-b")
  expect(h.cache.getArtist("same")).toBeUndefined()
  await h.switchTo("account-a")
  expect(h.cache.getArtist("same")?.artist.title).toBe("Private A")
})

test("live metadata loaded while hydration waits wins over older disk content", async () => {
  const loaded = deferred<string | null>()
  const provider = {
    cacheScope: "account",
    getAlbum: async (id) => album(id, "Live"),
    getAlbumTracks: async () => [],
    getRelatedHubs: async () => []
  } as unknown as MusicProvider
  const cache = createMetadataCache({
    getProvider: () => provider,
    storage: { getItem: () => loaded.promise, setItem: async () => {}, removeItem: async () => {} }
  })
  const activating = cache.activate(provider)
  await settle()
  await cache.loadAlbum("same")
  loaded.resolve(
    JSON.stringify({
      version: 2,
      scope: "account",
      state: {
        albums: {
          same: { album: album("same", "Disk"), tracks: [], relatedHubs: [], fetchedAt: Date.now() - 1000 }
        }
      }
    })
  )
  await activating
  expect(cache.getAlbum("same")?.album.title).toBe("Live")
})

test("malformed metadata and unknown legacy rows cannot poison a scoped cache", async () => {
  const h = harness()
  h.values.set(
    "plex-metadata-cache-v1",
    JSON.stringify({ state: { albums: { same: { album: album("same", "Private legacy") } } } })
  )
  h.values.set(
    "hibiki-metadata-v3:account-a",
    JSON.stringify({
      version: 2,
      scope: "account-a",
      state: {
        albums: {
          same: { album: album("different"), tracks: [], relatedHubs: [], fetchedAt: Date.now() },
          invalid: null
        },
        artists: []
      }
    })
  )
  await h.activate()
  expect(h.cache.getAlbum("same")).toBeUndefined()
  expect(h.cache.stats()).toEqual({ artistCount: 0, albumCount: 0 })
  expect(h.values.has("plex-metadata-cache-v1")).toBe(true)
})

test("cached artist albums follow the deduplication preference", async () => {
  const h = harness({ getArtistAlbums: async () => [album("original", "Same"), album("duplicate", "Same")] })
  await h.activate()
  const first = await h.cache.loadArtist("artist", { deduplicate: true })
  expect(first.albums).toHaveLength(1)
  expect(h.cache.getArtist("artist", false)).toBeUndefined()
  const second = await h.cache.loadArtist("artist", { deduplicate: false })
  expect(second.albums).toHaveLength(2)
  expect(h.cache.getArtist("artist", false)).toBe(second)
})

test("metadata leases belong to their own cache and retire on disconnect", async () => {
  const h = harness()
  await h.activate()
  const lease = h.cache.capture()
  const other = createMetadataCache({ getProvider: () => h.provider })
  await other.activate(h.provider)
  expect(other.current(lease)).toBe(false)
  expect(h.cache.current(lease)).toBe(true)
  h.cache.disconnect()
  expect(h.cache.current(lease)).toBe(false)
})

test("bad primary IDs do not populate the requested cache entry", async () => {
  const h = harness({ getArtist: async () => artist("wrong"), getAlbum: async () => album("wrong") })
  await h.activate()
  await expect(h.cache.loadArtist("wanted")).rejects.toThrow("different artist")
  await expect(h.cache.loadAlbum("wanted")).rejects.toThrow("different album")
  expect(h.cache.stats()).toEqual({ artistCount: 0, albumCount: 0 })
})

test("metadata entry limits keep the newly fetched item even when timestamps tie", async () => {
  const h = harness()
  await h.activate()
  for (let index = 0; index < 105; index++) await h.cache.loadAlbum(String(index))
  for (let index = 0; index < 55; index++) await h.cache.loadArtist(String(index))
  expect(h.cache.stats()).toEqual({ artistCount: 50, albumCount: 100 })
  expect(h.cache.getAlbum("104")).toBeDefined()
  expect(h.cache.getArtist("54")).toBeDefined()
})

test("saved metadata can hydrate before provider publication and is immediately readable afterward", async () => {
  const next = { cacheScope: "account" } as MusicProvider
  let published: MusicProvider | null = null
  const cache = createMetadataCache({
    getProvider: () => published,
    storage: {
      getItem: async () =>
        JSON.stringify({
          version: 2,
          scope: "account",
          state: {
            albums: {
              same: { album: album("same", "Saved"), tracks: [], relatedHubs: [], fetchedAt: Date.now() }
            }
          }
        }),
      setItem: async () => {},
      removeItem: async () => {}
    }
  })
  await cache.activate(next)
  expect(cache.getAlbum("same")).toBeUndefined()
  published = next
  expect(cache.getAlbum("same")?.album.title).toBe("Saved")
})
