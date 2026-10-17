import { expect, mock, test } from "bun:test"
import { createLibraryStore } from "../src/stores/libraryStore"
import type { MusicProvider } from "../src/providers/types"
import type { MusicAlbum, MusicPlaylist, MusicTrack } from "../src/types/music"
import { deferred, settle } from "./helpers/radioAudioFakes"

const track = (id: string, userRating: number | null = null) => ({ id, title: id, userRating }) as MusicTrack
const playlist = (id: string, trackCount = 1) =>
  ({ id, title: id, trackCount, type: "playlist" }) as MusicPlaylist
const release = (id: string) => ({ id, title: id, releaseDate: "2026-10-11" }) as MusicAlbum
function harness(overrides: Partial<MusicProvider> = {}, createLocalPlaylist = mock(async (title: string, ids: string[]) => ({ ...playlist("mixed:local", ids.length), title, providerKey: "hibiki" }))) {
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
  const makeProvider = (scope: string, overrides: Partial<MusicProvider> = {}) =>
    ({
      cacheScope: scope,
      getPlaylists: mock(async () => []),
      getRecentlyAdded: mock(async () => []),
      getHubs: mock(async () => []),
      getLikedTracks: mock(async () => []),
      getLikedArtists: mock(async () => []),
      getLikedAlbums: mock(async () => []),
      getTags: mock(async () => []),
      getPlaylistItems: mock(async () => ({ items: [], total: 0 })),
      getMixTracks: mock(async () => []),
      createPlaylist: mock(async (title) => playlist(title)),
      ...overrides
    }) as unknown as MusicProvider
  let provider = makeProvider("account-a", overrides)
  const store = createLibraryStore({ getProvider: () => provider, storage, delay: async () => {}, createLocalPlaylist })
  return {
    store,
    values,
    storage,
    state: () => store.getState(),
    provider,
    activate: async () => {
      await store.getState().activateProvider(provider)
    },
    switchTo: async (scope: string, overrides: Partial<MusicProvider> = {}) => {
      provider = makeProvider(scope, overrides)
      await store.getState().activateProvider(provider)
    },
    setProvider: (next: MusicProvider) => {
      provider = next
    }
  }
}

test("playlist A finishing after navigation to B updates its cache but cannot replace B", async () => {
  const old = deferred<{ items: MusicTrack[]; total: number }>()
  const h = harness({
    getPlaylistItems: mock(async (id) => (id === "a" ? old.promise : { items: [track("b-track")], total: 1 }))
  })
  await h.activate()
  h.store.setState({ playlists: [playlist("a"), playlist("b")] })
  const a = h.state().fetchPlaylistItems("a")
  await h.state().fetchPlaylistItems("b")
  old.resolve({ items: [track("a-track")], total: 1 })
  await a
  expect(h.state().currentPlaylistId).toBe("b")
  expect(h.state().currentPlaylistItems.map((track) => track.id)).toEqual(["b-track"])
  expect(h.state().playlistItemsCache.a.map((track) => track.id)).toEqual(["a-track"])
  expect(h.state().isLoading).toBe(false)
})

test("old playlist results and errors cannot populate a different account with the same playlist ID", async () => {
  const old = deferred<{ items: MusicTrack[]; total: number }>()
  const h = harness({ getPlaylistItems: mock(() => old.promise) })
  await h.activate()
  h.store.setState({ playlists: [playlist("same")] })
  const first = h.state().fetchPlaylistItems("same")
  await h.switchTo("account-b", {
    getPlaylistItems: mock(async () => ({ items: [track("new-track")], total: 1 }))
  })
  h.store.setState({ playlists: [playlist("same")] })
  await h.state().fetchPlaylistItems("same")
  old.reject(new Error("Old account error"))
  await first
  expect(h.state().currentPlaylistItems.map((track) => track.id)).toEqual(["new-track"])
  expect(h.state().error).toBeNull()
})

test("force-refresh wins over a slower old collection request and ordinary requests deduplicate", async () => {
  const old = deferred<MusicPlaylist[]>(),
    latest = deferred<MusicPlaylist[]>()
  let calls = 0
  const h = harness({ getPlaylists: mock(() => (++calls === 1 ? old.promise : latest.promise)) })
  await h.activate()
  const first = h.state().fetchPlaylists(),
    duplicate = h.state().fetchPlaylists()
  expect(calls).toBe(1)
  const forced = h.state().fetchPlaylists({ force: true })
  latest.resolve([playlist("new")])
  await forced
  old.resolve([playlist("old")])
  await first
  await duplicate
  expect(h.state().playlists.map((playlist) => playlist.id)).toEqual(["new"])
})

test("all home, liked and tag requests are fenced when their provider changes", async () => {
  const pending = deferred<any[]>()
  const h = harness({
    getPlaylists: () => pending.promise,
    getRecentlyAdded: () => pending.promise,
    getHubs: () => pending.promise,
    getLikedTracks: () => pending.promise,
    getLikedArtists: () => pending.promise,
    getLikedAlbums: () => pending.promise,
    getTags: () => pending.promise
  })
  await h.activate()
  const requests = [
    h.state().fetchPlaylists(),
    h.state().fetchRecentlyAdded(),
    h.state().fetchHubs(),
    h.state().fetchLikedTracks(),
    h.state().fetchLikedArtists(),
    h.state().fetchLikedAlbums(),
    h.state().fetchTags()
  ]
  await h.switchTo("account-b")
  pending.reject(new Error("Retired provider"))
  await Promise.all(requests)
  expect(h.state().playlists).toEqual([])
  expect(h.state().likedTracks).toEqual([])
  expect(h.state().tagsGenre).toEqual([])
  expect(h.state().error).toBeNull()
  expect(h.state()._hubsFetchedAt).toBeNull()
})

test("a larger liked/recent limit starts a new request and a smaller result cannot overwrite it", async () => {
  const small = deferred<MusicTrack[]>(),
    large = deferred<MusicTrack[]>(),
    limits: number[] = []
  const h = harness({
    getLikedTracks: mock((limit) => {
      limits.push(limit!)
      return limit === 10 ? small.promise : large.promise
    })
  })
  await h.activate()
  const first = h.state().fetchLikedTracks(10),
    second = h.state().fetchLikedTracks(20)
  large.resolve([track("large")])
  await second
  small.resolve([track("small")])
  await first
  expect(h.state().likedTracks[0].id).toBe("large")
  expect(h.state()._likedTracksLimit).toBe(20)
  await h.state().fetchLikedTracks(10)
  expect(limits).toEqual([10, 20])
})

test("background prefetch with an unknown length leaves a full initial page pageable", async () => {
  const h = harness({
    getPlaylistItems: mock(async (_id, offset = 0) => ({
      items: offset === 0 ? Array.from({ length: 50 }, (_, index) => track(String(index))) : offset === 50 ? [track("last")] : [],
      total: 0
    }))
  })
  await h.activate()
  h.store.setState({ playlists: [playlist("unknown", 0)] })
  await h.state().prefetchAllPlaylists()
  expect(h.state().playlistIsFullyLoaded.unknown).toBe(false)
  await h.state().fetchPlaylistItems("unknown")
  await h.state().fetchMorePlaylistItems("unknown")
  expect(h.state().currentPlaylistItems).toHaveLength(51)
  expect(h.state().playlistIsFullyLoaded.unknown).toBe(false)
  await h.state().fetchMorePlaylistItems("unknown")
  expect(h.state().playlistIsFullyLoaded.unknown).toBe(true)
})

test("a server-truncated small playlist is not marked complete before its advertised count", async () => {
  const h = harness({
    getPlaylistItems: mock(async (_id, offset = 0) => ({
      items: offset === 0 ? [track("first")] : [track("second")],
      total: 2
    }))
  })
  await h.activate()
  h.store.setState({ playlists: [playlist("list", 2)] })
  await h.state().fetchPlaylistItems("list")
  expect(h.state().playlistIsFullyLoaded.list).toBe(false)
  await h.state().fetchMorePlaylistItems("list")
  expect(h.state().playlistIsFullyLoaded.list).toBe(true)
  expect(h.state().currentPlaylistItems.map((track) => track.id)).toEqual(["first", "second"])
})

test("late pagination cannot clear a different playlist's loading indicator", async () => {
  const oldPage = deferred<{ items: MusicTrack[]; total: number }>(),
    newPage = deferred<{ items: MusicTrack[]; total: number }>()
  const h = harness({ getPlaylistItems: mock((id) => (id === "a" ? oldPage.promise : newPage.promise)) })
  await h.activate()
  h.store.setState({
    playlists: [playlist("a", 100), playlist("b", 100)],
    playlistItemsCache: { a: [track("a-first")], b: [track("b-first")] }
  })
  await h.state().fetchPlaylistItems("a")
  const a = h.state().fetchMorePlaylistItems("a")
  await h.state().fetchPlaylistItems("b")
  const b = h.state().fetchMorePlaylistItems("b")
  oldPage.resolve({ items: [track("a-next")], total: 2 })
  await a
  expect(h.state().isFetchingMore).toBe(true)
  expect(h.state().currentPlaylistItems.map((track) => track.id)).toEqual(["b-first"])
  newPage.resolve({ items: [track("b-next")], total: 2 })
  await b
  expect(h.state().isFetchingMore).toBe(false)
})

test("invalidation retires an in-flight initial page and its finally cannot remove the replacement", async () => {
  const old = deferred<{ items: MusicTrack[]; total: number }>(),
    newPage = deferred<{ items: MusicTrack[]; total: number }>()
  let calls = 0
  const h = harness({ getPlaylistItems: mock(() => (++calls === 1 ? old.promise : newPage.promise)) })
  await h.activate()
  h.store.setState({ playlists: [playlist("list")] })
  const first = h.state().fetchPlaylistItems("list")
  h.state().invalidatePlaylistItems("list")
  old.resolve({ items: [track("old")], total: 1 })
  await first
  const same = h.state().fetchPlaylistItems("list")
  expect(calls).toBe(2)
  newPage.resolve({ items: [track("new")], total: 1 })
  await same
  expect(h.state().currentPlaylistItems[0].id).toBe("new")
})

test("prefetch loops stop on disconnect and cannot fetch or store remaining old-server playlists", async () => {
  const old = deferred<{ items: MusicTrack[]; total: number }>(),
    called: string[] = []
  const h = harness({
    getPlaylistItems: mock((id) => {
      called.push(id)
      return old.promise
    })
  })
  await h.activate()
  h.store.setState({ playlists: [playlist("a"), playlist("b")] })
  const work = h.state().prefetchAllPlaylists()
  h.state().clearAll()
  old.resolve({ items: [track("old")], total: 1 })
  await work
  expect(called).toEqual(["a"])
  expect(h.state().playlistItemsCache).toEqual({})
  expect(h.state().prefetchStatus).toBeNull()
  expect(h.state().isLoading).toBe(false)
})

test("disconnect preserves saved scope data and reconnect restores only the matching library", async () => {
  const h = harness({ getPlaylists: mock(async () => [playlist("private-a")]) })
  await h.activate()
  await h.state().fetchPlaylists()
  h.state().addRecentMix([{ id: "artist", title: "Artist", thumb: null, subtitle: "Artist" }], "artist")
  h.state().clearAll()
  await h.switchTo("account-b")
  expect(h.state().playlists).toEqual([])
  expect(h.state().recentMixes).toEqual([])
  await h.switchTo("account-a")
  expect(h.state().playlists[0].id).toBe("private-a")
  expect(h.state().recentMixes).toHaveLength(1)
  expect([...h.values.keys()]).toContain("hibiki-library-v3:account-a")
})

test("malformed hydration cannot replace store actions or adopt another account's legacy data", async () => {
  const h = harness()
  h.values.set("plex-library-v1", JSON.stringify({ state: { playlists: [playlist("legacy-private")] } }))
  h.values.set(
    "hibiki-library-v3:account-a",
    JSON.stringify({
      version: 2,
      scope: "account-a",
      state: {
        playlists: [null, 123],
        hubs: [{ identifier: "bad" }],
        fetchPlaylists: "invalid",
        _playlistsFetchedAt: Number.MAX_SAFE_INTEGER
      }
    })
  )
  await h.activate()
  expect(h.state().playlists).toEqual([])
  expect(h.state().hubs).toEqual([])
  expect(typeof h.state().fetchPlaylists).toBe("function")
  expect(h.state()._playlistsFetchedAt).toBeNull()
  expect(h.values.has("plex-library-v1")).toBe(true)
})

test("empty tag results are cached, but partial failures remain retryable", async () => {
  let calls = 0,
    fail = true
  const h = harness({
    getTags: mock(async (kind) => {
      calls++
      if (fail && kind === "mood") throw new Error("Mood failed")
      return []
    })
  })
  await h.activate()
  await h.state().fetchTags()
  expect(h.state()._tagsFetchedAt).toBeNull()
  fail = false
  await h.state().fetchTags()
  await h.state().fetchTags()
  expect(calls).toBe(6)
  expect(h.state()._tagsFetchedAt).not.toBeNull()
})

test("rating changes are applied to a playlist response already in flight", async () => {
  const pending = deferred<{ items: MusicTrack[]; total: number }>()
  const h = harness({ getPlaylistItems: () => pending.promise })
  await h.activate()
  h.store.setState({ playlists: [playlist("list")] })
  const request = h.state().fetchPlaylistItems("list")
  h.state().onItemRated("song", "track", 10)
  pending.resolve({ items: [track("song", 0)], total: 1 })
  await request
  expect(h.state().currentPlaylistItems[0].userRating).toBe(10)
})

test("local draft creation survives a Plex change without entering either server's cache", async () => {
  const pending = deferred<MusicPlaylist>()
  const remote = mock(async () => playlist("remote"))
  const h = harness({ createPlaylist: remote }, mock(() => pending.promise))
  await h.activate()
  const creating = h
    .state()
    .createPlaylist("name")
    .catch((error) => error)
  await h.switchTo("account-b")
  pending.resolve(playlist("mixed:local"))
  expect((await creating).id).toBe("mixed:local")
  expect(remote).not.toHaveBeenCalled()
  expect(h.state().playlists).toEqual([])
})

test("pagination finishing after A to B to A navigation still publishes A's valid appended cache", async () => {
  const pending = deferred<{ items: MusicTrack[]; total: number }>()
  const h = harness({ getPlaylistItems: () => pending.promise })
  await h.activate()
  h.store.setState({
    playlists: [playlist("a", 2), playlist("b", 1)],
    playlistItemsCache: { a: [track("first")], b: [track("b")] }
  })
  await h.state().fetchPlaylistItems("a")
  const page = h.state().fetchMorePlaylistItems("a")
  await h.state().fetchPlaylistItems("b")
  await h.state().fetchPlaylistItems("a")
  pending.resolve({ items: [track("second")], total: 2 })
  await page
  expect(h.state().currentPlaylistItems.map((track) => track.id)).toEqual(["first", "second"])
  expect(h.state().playlistIsFullyLoaded.a).toBe(true)
})

test("a larger background initial page updates the visible list and obsolete pagination cannot truncate it", async () => {
  const small = deferred<{ items: MusicTrack[]; total: number }>(),
    large = deferred<{ items: MusicTrack[]; total: number }>(),
    more = deferred<{ items: MusicTrack[]; total: number }>()
  const h = harness({
    getPlaylistItems: mock(async (_id, offset, limit) =>
      offset ? more.promise : limit === 50 ? small.promise : large.promise
    )
  })
  await h.activate()
  const viewing = h.state().fetchPlaylistItems("list")
  h.store.setState({ playlists: [playlist("list", 3)] })
  const warming = h.state().prefetchAllPlaylists()
  small.resolve({ items: [track("first")], total: 1 })
  await viewing
  const pagination = h.state().fetchMorePlaylistItems("list")
  large.resolve({ items: [track("first"), track("second"), track("third")], total: 3 })
  await warming
  expect(h.state().currentPlaylistItems).toHaveLength(3)
  more.resolve({ items: [track("second")], total: 2 })
  await pagination
  expect(h.state().currentPlaylistItems).toHaveLength(3)
  expect(h.state().isFetchingMore).toBe(false)
})

test("live results arriving while hydration is pending win over older saved data", async () => {
  const loaded = deferred<string | null>()
  const provider = {
    cacheScope: "account",
    getPlaylists: async () => [playlist("fresh")]
  } as unknown as MusicProvider
  const store = createLibraryStore({
    getProvider: () => provider,
    storage: { getItem: () => loaded.promise, setItem: async () => {}, removeItem: async () => {} }
  })
  const activating = store.getState().activateProvider(provider)
  await settle()
  await store.getState().fetchPlaylists()
  loaded.resolve(
    JSON.stringify({
      version: 2,
      scope: "account",
      state: { playlists: [playlist("stale")], _playlistsFetchedAt: Date.now() - 1000 }
    })
  )
  await activating
  expect(store.getState().playlists[0].id).toBe("fresh")
})

test("library cache hydration completes before publication of its new provider", async () => {
  const next = { cacheScope: "account" } as MusicProvider
  let published: MusicProvider | null = null
  const store = createLibraryStore({
    getProvider: () => published,
    storage: {
      getItem: async () =>
        JSON.stringify({ version: 2, scope: "account", state: { playlists: [playlist("saved")] } }),
      setItem: async () => {},
      removeItem: async () => {}
    }
  })
  await store.getState().activateProvider(next)
  published = next
  expect(store.getState().playlists[0].id).toBe("saved")
})

test("authoritative page totals replace stale playlist counts and retain duplicate occurrences", async () => {
  const offsets: number[] = []
  const h = harness({ getPlaylistItems: mock(async (_id, offset = 0) => {
    offsets.push(offset)
    return { items: offset === 0 ? [track("same"), track("same")] : [track("third"), track("fourth"), track("fifth")], total: 5 }
  }) })
  await h.activate()
  h.store.setState({ playlists: [playlist("grown", 2)] })
  await h.state().fetchPlaylistItems("grown")
  expect(h.state().playlistIsFullyLoaded.grown).toBe(false)
  expect(h.state().currentPlaylist?.trackCount).toBe(5)
  await h.state().fetchMorePlaylistItems("grown")
  expect(offsets).toEqual([0, 2])
  expect(h.state().currentPlaylistItems.map(item => item.id)).toEqual(["same", "same", "third", "fourth", "fifth"])
  expect(h.state().playlistIsFullyLoaded.grown).toBe(true)
})

test("unknown totals do not let stale counts terminate full pages and an empty page is terminal", async () => {
  const h = harness({ getPlaylistItems: mock(async (_id, offset = 0) => ({ items: offset === 0 ? [track("a"), track("b")] : [], total: 0 })) })
  await h.activate()
  h.store.setState({ playlists: [playlist("unknown", 2)] })
  await h.state().fetchPlaylistItems("unknown")
  expect(h.state().playlistIsFullyLoaded.unknown).toBe(false)
  await h.state().fetchMorePlaylistItems("unknown")
  expect(h.state().playlistIsFullyLoaded.unknown).toBe(true)
  expect(h.state().playlists[0].trackCount).toBe(2)
})

test("a later authoritative total keeps a growing playlist pageable", async () => {
  const h = harness({ getPlaylistItems: mock(async (_id, offset = 0) => ({
    items: offset === 0 ? [track("a"), track("b")] : offset === 2 ? [track("c"), track("d")] : [track("e")],
    total: offset === 0 ? 4 : 5
  })) })
  await h.activate()
  h.store.setState({ playlists: [playlist("growing", 2)] })
  await h.state().fetchPlaylistItems("growing")
  await h.state().fetchMorePlaylistItems("growing")
  expect(h.state().playlistIsFullyLoaded.growing).toBe(false)
  expect(h.state().currentPlaylist?.trackCount).toBe(5)
  await h.state().fetchMorePlaylistItems("growing")
  expect(h.state().currentPlaylistItems).toHaveLength(5)
  expect(h.state().playlistIsFullyLoaded.growing).toBe(true)
})

test("unknown totals allow server-clamped short pages until an empty page", async () => {
  const offsets: number[] = []
  const h = harness({ getPlaylistItems: mock(async (_id, offset = 0) => {
    offsets.push(offset)
    return { items: offset === 0 ? [track("a")] : offset === 1 ? [track("b")] : [], total: 0 }
  }) })
  await h.activate()
  h.store.setState({ playlists: [playlist("clamped", 2)] })
  await h.state().fetchPlaylistItems("clamped")
  expect(h.state().playlistIsFullyLoaded.clamped).toBe(false)
  await h.state().fetchMorePlaylistItems("clamped")
  expect(h.state().playlistIsFullyLoaded.clamped).toBe(false)
  await h.state().fetchMorePlaylistItems("clamped")
  expect(h.state().playlistIsFullyLoaded.clamped).toBe(true)
  expect(offsets).toEqual([0, 1, 2])
  expect(h.state().currentPlaylistItems.map(item => item.id)).toEqual(["a", "b"])
})

test("latest releases deduplicate requests, respect requested limits and retire old provider results", async () => {
  const pending = deferred<MusicAlbum[]>()
  const getLatestReleases = mock(async () => pending.promise)
  const h = harness({ getLatestReleases })
  await h.activate()
  const first = h.state().fetchLatestReleases(30)
  const duplicate = h.state().fetchLatestReleases(30)
  expect(getLatestReleases).toHaveBeenCalledTimes(1)
  await h.switchTo("account-b", { getLatestReleases: async () => [release("new-account")] })
  await h.state().fetchLatestReleases(30)
  pending.resolve([release("old-account")])
  await Promise.all([first, duplicate])
  expect(h.state().latestReleases.map(album => album.id)).toEqual(["new-account"])
  expect(h.state()._latestReleasesLimit).toBe(30)
  const current = h.state()._latestReleasesFetchedAt
  await h.state().fetchLatestReleases(30)
  expect(h.state()._latestReleasesFetchedAt).toBe(current)
  h.state().invalidateLibraryTTLs()
  expect(h.state()._latestReleasesFetchedAt).toBeNull()
})

test("failed latest releases retry without a successful TTL and optional providers remain compatible", async () => {
  let attempts = 0
  const h = harness({ getLatestReleases: async limit => {
    expect(limit).toBe(50)
    if (++attempts === 1) throw new Error("synthetic fetch failure")
    return [release("retry")]
  } })
  await h.activate()
  await h.state().fetchLatestReleases(500)
  expect(h.state()._latestReleasesFetchedAt).toBeNull()
  await h.state().fetchLatestReleases(500)
  expect(attempts).toBe(2)
  expect(h.state().latestReleases.map(album => album.id)).toEqual(["retry"])
  await h.switchTo("optional-provider")
  await h.state().fetchLatestReleases()
  expect(h.state().latestReleases).toEqual([])
  expect(h.state()._latestReleasesFetchedAt).toBeNull()
})

test("latest-release shelf persistence restores only its provider scope and album ratings stay current", async () => {
  const h = harness({ getLatestReleases: async () => [release("a")] })
  await h.activate()
  await h.state().fetchLatestReleases()
  h.state().onItemRated("a", "album", 8)
  expect(h.state().latestReleases[0].userRating).toBe(8)
  await settle()
  await h.switchTo("account-b", { getLatestReleases: async () => [release("b")] })
  expect(h.state().latestReleases).toEqual([])
  await h.state().fetchLatestReleases()
  await settle()
  await h.switchTo("account-a", { getLatestReleases: async () => [] })
  expect(h.state().latestReleases.map(album => album.id)).toEqual(["a"])
  expect(h.state().latestReleases[0].userRating).toBe(8)
  expect(h.state()._latestReleasesLimit).toBe(30)
})

test("speculative prefetch skips smart playlists while preserving regular complete caches", async () => {
  const calls: string[] = []
  const h = harness({ getPlaylistItems: mock(async (id, offset = 0, limit = 0) => {
    calls.push(id)
    return { items: Array.from({ length: limit }, (_, i) => track(`${id}-${i}`)), total: limit, offset }
  }) })
  await h.activate()
  h.store.setState({ playlists: [{ ...playlist("smart", 20), smart: true }, { ...playlist("regular", 90), smart: false }] })
  await h.state().prefetchAllPlaylists()
  expect(calls).toEqual(["regular"])
  await h.state().fetchPlaylistItems("regular")
  expect(h.state().currentPlaylistItems).toHaveLength(90)
  expect(h.state().playlistIsFullyLoaded.regular).toBe(true)
  expect(calls).toEqual(["regular"])
})

test("oversized pages fail without entering the cache or advancing the offset", async () => {
  let oversized = true
  const offsets: number[] = []
  const h = harness({ getPlaylistItems: mock(async (_id, offset = 0, limit = 0) => {
    offsets.push(offset)
    return { items: Array.from({ length: oversized ? limit + 1 : limit }, (_, i) => track(String(i))), total: 0, offset }
  }) })
  await h.activate(); h.store.setState({ playlists: [playlist("bounded", 20)] })
  await h.state().fetchPlaylistItems("bounded")
  expect(h.state().currentPlaylistItems).toEqual([])
  expect(h.state().playlistItemsCache.bounded).toBeUndefined()
  expect(h.state().error).toContain("unexpected page")
  await h.state().fetchMorePlaylistItems("bounded")
  expect(offsets).toEqual([0], "initial failure must not start automatic pagination")
  oversized = false
  await h.state().fetchPlaylistItems("bounded")
  expect(h.state().currentPlaylistItems).toHaveLength(20)
  expect(h.state().playlistIsFullyLoaded.bounded).toBe(false)
})

test("impossible old cache is refetched instead of rendered or silently trimmed", async () => {
  const h = harness({ getPlaylistItems: mock(async () => ({ items: [track("fresh")], total: 20, offset: 0 })) })
  await h.activate()
  h.store.setState({ playlists: [playlist("stale", 20)], playlistItemsCache: { stale: Array.from({ length: 5000 }, (_, i) => track(String(i))) }, playlistIsFullyLoaded: { stale: false } })
  await h.state().fetchPlaylistItems("stale")
  expect(h.provider.getPlaylistItems).toHaveBeenCalledTimes(1)
  expect(h.state().currentPlaylistItems.map(track => track.id)).toEqual(["fresh"])
  expect(h.state().playlistIsFullyLoaded.stale).toBe(false)
})

test("nonadvancing pages retain loaded songs and retire automatic retries until explicit retry", async () => {
  let badOffset = true
  const calls: number[] = []
  const h = harness({ getPlaylistItems: mock(async (_id, offset = 0) => {
    calls.push(offset)
    return { items: [track(offset === 0 ? "first" : "next")], total: 3, offset: offset && badOffset ? 0 : offset }
  }) })
  await h.activate(); h.store.setState({ playlists: [playlist("offset", 3)] })
  await h.state().fetchPlaylistItems("offset")
  await h.state().fetchMorePlaylistItems("offset")
  expect(h.state().currentPlaylistItems.map(track => track.id)).toEqual(["first"])
  expect(h.state().playlistPageErrors.offset).toBeTruthy()
  expect(h.state().isFetchingMore).toBe(false)
  await h.state().fetchMorePlaylistItems("offset")
  expect(calls).toEqual([0, 1])
  badOffset = false
  await h.state().fetchMorePlaylistItems("offset", { force: true })
  expect(calls).toEqual([0, 1, 1])
  expect(h.state().currentPlaylistItems.map(track => track.id)).toEqual(["first", "next"])
  expect(h.state().playlistPageErrors.offset).toBeUndefined()
})

test("repeated occurrence IDs are rejected while valid duplicate track occurrences remain", async () => {
  let repeated = true
  const h = harness({ getPlaylistItems: mock(async (_id, offset = 0) => ({
    items: [{ ...track("same-song"), playlistItemId: offset && !repeated ? "second-occurrence" : "first-occurrence" }], total: 2, offset,
  })) })
  await h.activate(); h.store.setState({ playlists: [playlist("occurrences", 2)] })
  await h.state().fetchPlaylistItems("occurrences")
  await h.state().fetchMorePlaylistItems("occurrences")
  expect(h.state().currentPlaylistItems).toHaveLength(1)
  expect(h.state().playlistPageErrors.occurrences).toBeTruthy()
  repeated = false
  await h.state().fetchMorePlaylistItems("occurrences", { force: true })
  expect(h.state().currentPlaylistItems.map(track => track.id)).toEqual(["same-song", "same-song"])
  expect(h.state().currentPlaylistItems.map(track => track.playlistItemId)).toEqual(["first-occurrence", "second-occurrence"])
  expect(h.state().playlistIsFullyLoaded.occurrences).toBe(true)
})

test("offline activation rechecks saved playlists instead of restoring online availability and TTLs", async () => {
  const online = { ...playlist("downloaded"), offlineAvailable: undefined }
  const h = harness({getPlaylists:async () => [online]})
  await h.activate()
  await h.state().fetchPlaylists()
  await h.switchTo("account-a", {isOffline:true,getPlaylists:async () => [{...online,offlineAvailable:true}]})
  expect(h.state().playlists).toEqual([])
  await h.state().fetchPlaylists()
  expect(h.state().playlists[0].offlineAvailable).toBe(true)
})


test("playlist creation admits selected occurrences through the local lifecycle, leaving remote creation deferred", async () => {
  const createPlaylist = mock(async () => playlist("remote", 3))
  const local = mock(async (_title: string, _ids: string[]) => playlist("mixed:new", 3))
  const h = harness({ createPlaylist }, local)
  await h.activate()
  const created = await h.state().createPlaylist("Selected songs", ["1", "2", "1"])
  expect(local.mock.calls).toEqual([["Selected songs", ["1", "2", "1"]]])
  expect(createPlaylist).not.toHaveBeenCalled()
  expect(created.trackCount).toBe(3)
  expect(h.state().playlists).toEqual([])
})
