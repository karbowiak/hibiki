import { afterEach, expect, test } from "bun:test"
import { createSearchStore } from "../src/stores/searchStore"
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
