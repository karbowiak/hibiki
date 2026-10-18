import { expect, test } from "bun:test"
import { createMatchingBatch } from "../src/matching/batch"
import { matchingIdentifiers } from "../src/matching/sources"
import type { MatchingSource, MatchingResolution } from "../src/matching/resolverTypes"
import { deferred } from "./helpers/radioAudioFakes"

const source = (id = "one"): MatchingSource => ({ id: `ytmusic:${id}`, kind: "track", title: "Song", artists: ["Artist"], identifiers: [], duration: 180000, catalog: [], trackList: [] })
const result = (input: MatchingSource, changes: Partial<MatchingResolution> = {}): MatchingResolution => ({ sourceId: input.id, status: "matched", candidates: [], selected: 7, recordingIdentity: null, coverage: "complete", revision: 1, cached: false, limited: false, ...changes })

test("shared index batches and coalesces requests without retaining completed renderer results", async () => {
  const calls: MatchingSource[][] = []
  const resolve = createMatchingBatch({ current: () => true, delay: 0, lookup: async inputs => { calls.push(inputs); return inputs.map(input => result(input)) } })
  const a = resolve(source()), same = resolve(source())
  expect(a).toBe(same)
  await Promise.all([a, ...Array.from({ length: 39 }, (_, index) => resolve(source(String(index))))])
  expect(calls.length).toBe(3)
  expect(Math.max(...calls.map(call => call.length))).toBe(16)
  await resolve(source())
  expect(calls.length).toBe(4)
})

test("matching retires stale owners before IPC and after a delayed native result", async () => {
  let current = true, calls = 0
  const pending = deferred<MatchingResolution[]>()
  const resolve = createMatchingBatch({ current: () => current, delay: 0, lookup: () => { calls++; return pending.promise } })
  const work = resolve(source())
  await Bun.sleep(5)
  current = false
  pending.resolve([result(source())])
  await expect(work).rejects.toThrow("owner changed")
  await expect(resolve(source("later"))).rejects.toThrow("owner changed")
  expect(calls).toBe(1)
})

test("incomplete discovery uses a bounded fallback but cached negatives and ambiguity do not repeat network requests", async () => {
  let calls = 0
  const resolve = createMatchingBatch({ current: () => true, delay: 0,
    lookup: async inputs => inputs.map(input => result(input, { status: input.id.endsWith("ambiguous") ? "ambiguous" : "incomplete", selected: null, cached: input.id.endsWith("cached") })),
    fallback: async input => { calls++; return result(input) },
  })
  expect((await resolve(source())).selected).toBe(7)
  expect((await resolve(source("cached"))).status).toBe("incomplete")
  expect((await resolve(source("ambiguous"))).status).toBe("ambiguous")
  expect(calls).toBe(1)
  await resolve(source("cached"), true)
  expect(calls).toBe(2)
})

test("fallback failure is distinct from absence and cannot fabricate a selected target", async () => {
  const resolve = createMatchingBatch({ current: () => true, delay: 0,
    lookup: async inputs => inputs.map(input => result(input, { status: "stale", selected: null })),
    fallback: async () => { throw Error("provider unavailable") },
  })
  const found = await resolve(source())
  expect(found.status).toBe("provider-error")
  expect(found.selected).toBeNull()
})

test("index growth retries local identities without repeating a source's live fallback every page", async () => {
  let calls = 0, revision = 0
  const resolve = createMatchingBatch({ current: () => true, delay: 0,
    lookup: async inputs => inputs.map(input => result(input, { status: "incomplete", selected: null, cached: false, revision: ++revision })),
    fallback: async input => { calls++; return result(input, { status: "incomplete", selected: null }) },
  })
  await resolve(source())
  await resolve(source())
  await resolve(source())
  expect(calls).toBe(1)
  await resolve(source(), true)
  expect(calls).toBe(2)
})
test("passive matching queries never schedule a provider fallback", async () => {
  let calls = 0
  const resolve = createMatchingBatch({ current: () => true, delay: 0,
    lookup: async inputs => inputs.map(input => result(input, { status: "incomplete", selected: null })),
    fallback: async input => { calls++; return result(input) },
  })
  expect((await resolve(source(), false, false)).status).toBe("incomplete")
  expect(calls).toBe(0)
  expect((await resolve(source())).status).toBe("matched")
  expect(calls).toBe(1)
})

test("slow partial-index provider fallbacks cannot hold verified replies or subsequent native lookup batches", async () => {
  const gate = deferred<void>()
  let started = false
  const resolve = createMatchingBatch({ current: () => true, delay: 0,
    lookup: async inputs => inputs.map(input => result(input, input.id === "ytmusic:slow" ? { status: "incomplete", selected: null, cached: false } : {})),
    fallback: async input => { started = true; await gate.promise; return result(input) },
  })
  const slow = resolve(source("slow"))
  const quick = resolve(source("quick"))
  for (let tick = 0; tick < 20 && !started; tick++) await Bun.sleep(1)
  expect(started).toBe(true)
  expect((await quick).status).toBe("matched")
  expect((await resolve(source("later"))).status).toBe("matched")
  gate.resolve(); await slow
})

test("wrong or truncated IPC batches fail every affected lookup without misrouting identities", async () => {
  for (const lookup of [async () => [], async () => [result(source("wrong"))]]) {
    const resolve = createMatchingBatch({ current: () => true, delay: 0, lookup })
    await expect(resolve(source())).rejects.toThrow("different batch")
  }
})

test("simultaneous matching is bounded and force does not contaminate normal lookup batches", async () => {
  const gate = deferred<void>(), flags: boolean[] = []
  const resolve = createMatchingBatch({ current: () => true, delay: 0, lookup: async (inputs, force) => { flags.push(force); await gate.promise; return inputs.map(input => result(input)) } })
  const work = Array.from({ length: 256 }, (_, index) => resolve(source(String(index)), index % 2 === 0))
  await expect(resolve(source("overflow"))).rejects.toThrow("busy")
  gate.resolve()
  await Promise.all(work)
  expect(flags.filter(Boolean).length).toBe(8)
  expect(flags.filter(flag => !flag).length).toBe(8)
})

test("typed identifier extraction never treats generic Plex MBIDs as recordings", () => {
  const id = "12345678-1234-1234-1234-123456789012"
  expect(matchingIdentifiers(`mbid://${id}`)).toEqual([])
  expect(matchingIdentifiers(`musicbrainz://recording/${id}`)).toEqual([{ scheme: "musicbrainz:recording", value: id }])
  expect(matchingIdentifiers(`musicbrainz://release/${id}`)[0].scheme).toBe("musicbrainz:release")
  expect(matchingIdentifiers("musicbrainz://recording/not-an-id")).toEqual([])
})

test("a hung native batch releases its coalescing slot and permits a retry", async () => {
  let calls = 0
  const resolve = createMatchingBatch({ current: () => true, delay: 0, timeoutMs: 10,
    lookup: async inputs => ++calls === 1 ? new Promise<never>(() => {}) : inputs.map(input => result(input)),
  })
  const first = await Promise.allSettled([resolve(source()), resolve(source())])
  expect(first.every(item => item.status === "rejected")).toBe(true)
  expect((await resolve(source())).selected).toBe(7)
  expect(calls).toBe(2)
})
