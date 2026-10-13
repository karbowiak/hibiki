import { expect, test } from "bun:test"
import { createSoulSyncStore } from "../src/metadata/soulsync/store"
import { nativeSoulSyncAdapter } from "../src/metadata/soulsync/adapter"
import { deferred } from "./helpers/radioAudioFakes"
const status = {
  revision: "one",
  baseUrl: "https://synthetic.test",
  configured: true,
  enabled: true,
}
test("SoulSync store owns only native status, preserves failed settings and clears keys only explicitly", async () => {
  const calls: any[] = []
  let fail = false
  const store = createSoulSyncStore(
    {
      status: async () => status,
      configure: async (args) => {
        calls.push(args)
        if (fail) throw Error("private upstream detail")
        return {
          ...status,
          revision: "two",
          configured: !args.clear,
          enabled: !args.clear,
        }
      },
    },
    () => true
  )
  await store.getState().load()
  expect(
    await store.getState().configure({
      baseUrl: status.baseUrl,
      apiKey: "synthetic-secret",
      enabled: true,
    })
  ).toBe(true)
  expect(JSON.stringify(store.getState())).not.toContain("synthetic-secret")
  fail = true
  expect(
    await store
      .getState()
      .configure({ baseUrl: status.baseUrl, enabled: false })
  ).toBe(false)
  expect(store.getState().status?.enabled).toBe(true)
  expect(store.getState().error).not.toContain("private upstream detail")
  fail = false
  expect(
    await store
      .getState()
      .configure({ baseUrl: status.baseUrl, clear: true, enabled: false })
  ).toBe(true)
  expect(store.getState().status?.configured).toBe(false)
  expect(calls[2]).toMatchObject({ clear: true, apiKey: null })
})
test("native SoulSync adapter stays silent while unconfigured and retires old configuration replies", async () => {
  let current = status,
    calls = 0
  const pending = deferred<any>()
  const lookup = async () => {
    calls++
    return pending.promise
  }
  const disabled = nativeSoulSyncAdapter(null, () => current, lookup)
  expect(
    await disabled.lookup({
      kind: "artist",
      artist: "Artist",
      scope: "library",
    })
  ).toEqual({ status: "unavailable" })
  expect(calls).toBe(0)
  const adapter = nativeSoulSyncAdapter(
    status,
    () => current,
    lookup,
    async () => ({ status: "unavailable" })
  )
  expect(
    await adapter.lookup({
      kind: "album",
      artist: "Artist",
      title: "Album",
      scope: "library",
    })
  ).toEqual({ status: "unavailable" })
  expect(calls).toBe(0)
  const request = adapter.lookup({
    kind: "artist",
    artist: "Artist",
    scope: "library",
  })
  current = { ...status, revision: "replacement" }
  pending.resolve({
    name: "Artist",
    summary: "Old biography",
    thumbUrl: null,
    genres: [],
    label: null,
    mbid: null,
  })
  expect(await request).toEqual({ status: "retired" })
  expect(calls).toBe(1)
})
test("SoulSync targeted refresh retries only the current snapshot without a global provider cache clear", async () => {
  const { createMetadataClient } = await import("../src/metadata/core/client")
  let calls = 0
  const adapter = nativeSoulSyncAdapter(
    status,
    () => status,
    async () => {
      calls++
      return {
        name: "Artist",
        summary: `Biography ${calls}`,
        thumbUrl: null,
        genres: [],
        label: null,
        mbid: null,
      }
    }
  )
  const identity = {
    kind: "artist" as const,
    artist: "Artist",
    scope: "library",
  }
  const client = createMetadataClient([adapter], () => ({
    scope: "library",
    token: "owner",
  }))
  await client.lookup("soulsync", identity)
  await client.lookup("soulsync", identity)
  expect(calls).toBe(1)
  expect(client.invalidate("soulsync", identity)).toBe(true)
  const result = await client.lookup("soulsync", identity)
  expect(result).toMatchObject({
    status: "ready",
    snapshot: { fields: { biography: "Biography 2" } },
  })
  expect(calls).toBe(2)
})
test("native ambiguity stays explicit and aggregate field provenance is retained", async () => {
  const identity = {
    kind: "artist" as const,
    artist: "Artist",
    scope: "library",
  }
  const ambiguous = nativeSoulSyncAdapter(
    status,
    () => status,
    async () => ({
      status: "ambiguous",
      candidates: [
        { id: "42", name: "Artist" },
        { id: "99", name: "Artist" },
      ],
    })
  )
  expect(await ambiguous.lookup(identity)).toMatchObject({
    status: "ambiguous",
    candidates: [{ id: "42" }, { id: "99" }],
  })
  const ready = nativeSoulSyncAdapter(
    status,
    () => status,
    async () => ({
      status: "ready",
      artist: {
        name: "Artist",
        summary: "Matched biography",
        summaryOrigin: "Last.fm via SoulSync",
        thumbUrl: null,
        genres: [],
        tags: ["Dance"],
        listeners: 123,
        playCount: 456,
        label: null,
        mbid: null,
      },
    })
  )
  expect(await ready.lookup(identity)).toMatchObject({
    status: "ready",
    snapshot: {
      fields: {
        biography: "Matched biography",
        tags: ["Dance"],
        listeners: 123,
      },
      fieldOrigins: {
        biography: "Last.fm via SoulSync",
        tags: "Last.fm via SoulSync",
      },
    },
  })
})

test("SoulSync album/track enrichment projects verified fields and retires a replaced service", async () => {
  let current = status
  const pending = deferred<any>()
  const calls: any[] = []
  const adapter = nativeSoulSyncAdapter(
    status,
    () => current,
    async () => null,
    async (...args) => {
      calls.push(args)
      return pending.promise
    }
  )
  const identity = {
    kind: "album" as const,
    artist: "Artist",
    title: "Album",
    scope: "library",
  }
  const request = adapter.lookup(identity)
  pending.resolve({
    status: "ready",
    item: {
      artist: "Artist",
      title: "Album",
      fields: { summary: "Album context", trackCount: 12 },
      fieldOrigins: { summary: "Last.fm via SoulSync" },
    },
  })
  expect(await request).toMatchObject({
    status: "ready",
    snapshot: {
      identity,
      fields: { summary: "Album context", trackCount: 12 },
      fieldOrigins: { summary: "Last.fm via SoulSync" },
    },
  })
  expect(calls).toEqual([["one", "album", "Artist", "Album"]])
  const late = deferred<any>()
  const retiring = nativeSoulSyncAdapter(
    status,
    () => current,
    async () => null,
    async () => late.promise
  )
  const job = retiring.lookup({ ...identity, kind: "track", title: "Song" })
  current = { ...status, revision: "changed" }
  late.resolve({
    status: "ready",
    item: {
      artist: "Artist",
      title: "Song",
      fields: { summary: "Retired" },
      fieldOrigins: {},
    },
  })
  expect(await job).toEqual({ status: "retired" })
})
