import { afterEach, expect, test } from "bun:test"
import { createSearchStore } from "../src/stores/searchStore"
import { youtubeMusicItemMusic } from "../src/backends/ytmusic/discovery"
import { mergeMusicSearchResults } from "../src/lib/musicMatching"
import {
  clearRecentSearches,
  getRecentSearches,
  recordRecentSearch,
} from "../src/lib/recentSearches"
import type { MusicProvider } from "../src/providers/types"
import { deferred } from "./helpers/radioAudioFakes"
const result = (id: string) => [{ type: "artist", id, title: id }] as any
function fixture() {
  const requests = new Map<string, ReturnType<typeof deferred<any>>>()
  let provider = {
    search: (q: string) => {
      const value = deferred<any>()
      requests.set(q, value)
      return value.promise
    },
  } as MusicProvider
  const recent: string[] = []
  const store = createSearchStore(
    () => provider,
    (q) => {
      recent.push(q)
    }
  )
  return {
    store,
    requests,
    recent,
    replace: () => {
      provider = { search: async () => [] } as any
    },
  }
}
test("an older search cannot overwrite a newer query or record stale history", async () => {
  const { store, requests, recent } = fixture()
  const first = store.getState().search("First")
  const second = store.getState().search("Second")
  requests.get("Second")!.resolve(result("Current"))
  await second
  requests.get("First")!.resolve(result("Old"))
  await first
  expect(store.getState().results).toEqual(result("Current"))
  expect(store.getState().query).toBe("Second")
  expect(recent).toEqual(["Second"])
})
test("a typed query invalidates previous results before its debounced fetch starts", async () => {
  const { store, requests } = fixture()
  const first = store.getState().search("First")
  store.getState().setQuery("Second")
  requests.get("First")!.resolve(result("Old"))
  await first
  expect(store.getState().results).toEqual([])
  expect(store.getState().isSearching).toBe(true)
})
test("clearing search and changing provider retire late results and failures", async () => {
  for (const clear of [false, true]) {
    const environment = fixture()
    const request = environment.store.getState().search("First")
    if (clear) environment.store.getState().clear()
    else environment.replace()
    environment.requests.get("First")!.reject(new Error("Old failure"))
    await request
    expect(environment.store.getState().error).toBeNull()
    expect(environment.store.getState().results).toEqual([])
    expect(environment.recent).toEqual([])
  }
})
test("history storage failure preserves a successful provider search", async () => {
  const provider = { search: async () => result("Found") } as any
  const store = createSearchStore(
    () => provider,
    () => {
      throw new Error("Quota exhausted")
    }
  )
  await store.getState().search("Query")
  expect(store.getState().results).toEqual(result("Found"))
  expect(store.getState().error).toBeNull()
})
test("a current search failure clears old results and supports retry", async () => {
  let fail = true
  const store = createSearchStore(
    () => provider,
    () => {}
  )
  const provider = {
    search: async () => {
      if (fail) throw new Error("Temporary")
      return result("Recovered")
    },
  } as any
  await store.getState().search("Query")
  expect(store.getState().error).toContain("Temporary")
  fail = false
  await store.getState().search("Query")
  expect(store.getState().error).toBeNull()
  expect(store.getState().results).toEqual(result("Recovered"))
})
test("an artist absent from Plex remains searchable through YTM with cached artwork", async () => {
  const provider = { search: async () => [] } as unknown as MusicProvider
  const store = createSearchStore(() => provider, () => {}, {
    owner: () => "ytmusic:1",
    search: async () => [youtubeMusicItemMusic({
      id: "UC_winking_owl", kind: "artist", title: "The Winking Owl", artist: "",
      thumbnail: "https://lh3.googleusercontent.com/winking-owl", duration: null, album: null, year: null,
    })],
    merge: mergeMusicSearchResults,
  })
  await store.getState().search("the winking owl")
  const state = store.getState()
  expect(state.error).toBeNull()
  expect(state.isSearching).toBe(false)
  expect(state.results).toHaveLength(1)
  expect(state.results[0].title).toBe("The Winking Owl")
  expect(state.results[0].providerKey).toBe("ytmusic")
  expect(state.results[0].thumbUrl).toContain("/ext/img?src=")
})
test("an empty Plex response cannot hide a failed YTM search", async () => {
  const provider = { search: async () => [] } as unknown as MusicProvider
  const store = createSearchStore(() => provider, () => {}, {
    owner: () => "ytmusic:1",
    search: async () => { throw new Error("Temporary failure") },
    merge: mergeMusicSearchResults,
  })
  await store.getState().search("the winking owl")
  expect(store.getState().results).toEqual([])
  expect(store.getState().isSearching).toBe(false)
  expect(store.getState().error).toContain("YouTube Music: Error: Temporary failure")
})
const originalStorage = globalThis.localStorage
afterEach(() => {
  globalThis.localStorage = originalStorage
})
test("malformed or unavailable history is safe to render and remains untouched by recording", () => {
  for (const raw of [
    "null",
    "{broken",
    '["Good",42]',
    '{"query":"wrong shape"}',
  ]) {
    let saved = raw
    globalThis.localStorage = {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value
      },
    } as any
    expect(getRecentSearches()).toEqual([])
    recordRecentSearch("New")
    expect(saved).toBe(raw)
  }
  let writes = 0
  globalThis.localStorage = {
    getItem: () => {
      throw new Error("Denied")
    },
    setItem: () => {
      writes++
    },
    removeItem: () => {
      throw new Error("Denied")
    },
  } as any
  expect(getRecentSearches()).toEqual([])
  recordRecentSearch("New")
  expect(writes).toBe(0)
  expect(clearRecentSearches()).toBe(false)
})

test("changed local-first search results update only the active owner/query and win an early refresh race", async () => {
  const scope = `plex-${"a".repeat(64)}`,
    session = {}
  const pending = deferred<any>()
  let provider = {
    cacheScope: scope,
    playbackSession: session,
    search: () => pending.promise,
  } as MusicProvider
  const store = createSearchStore(
    () => provider,
    () => {}
  )
  const request = store.getState().search("Query")
  store.getState().acceptLocalRefresh(scope, session, "Query", result("Fresh"))
  pending.resolve(result("Saved"))
  await request
  expect(store.getState().results).toEqual(result("Fresh"))
  store
    .getState()
    .acceptLocalRefresh(scope, session, "Other", result("Wrong query"))
  expect(store.getState().results).toEqual(result("Fresh"))
  provider = {
    cacheScope: scope,
    playbackSession: {},
    search: async () => [],
  } as unknown as MusicProvider
  store
    .getState()
    .acceptLocalRefresh(scope, session, "Query", result("Old session"))
  expect(store.getState().results).toEqual(result("Fresh"))
})

test("late providers join canonical categories and refreshed snapshots retire missing results", async () => {
  const local = deferred<any>(), remote = deferred<any>()
  const plex = { search: () => local.promise } as any
  let owner = "account-one"
  const store = createSearchStore(() => plex, () => {}, {
    owner: () => owner, search: () => remote.promise, merge: mergeMusicSearchResults,
  })
  const query = store.getState().search("test")
  remote.resolve([{ type: "track", providerKey: "ytmusic", id: "ytmusic:one", title: "First", artistName: "A" }])
  await Bun.sleep(0)
  const first = store.getState().suggestions[0]
  expect(first.id).toBe("ytmusic:one")
  local.resolve([{ type: "artist", id: "local", title: "Late artist" }])
  await query
  expect(store.getState().suggestions[1]).toBe(first)
  expect(store.getState().suggestions[0].id).toBe("local")
  store.getState().acceptSupplementalRefresh("test", [])
  expect(store.getState().suggestions.map(item => item.id)).toEqual(["local"])
  const context = store.getState().context
  owner = "account-two"
  const next = store.getState().search("test")
  expect(store.getState().suggestions).toEqual([])
  expect(store.getState().results).toEqual([])
  expect(store.getState().context).toBeGreaterThan(context)
  await next
  store.getState().setQuery("new")
  expect(store.getState().suggestions).toEqual([])
})
