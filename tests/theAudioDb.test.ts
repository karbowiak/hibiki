import { test, expect } from "bun:test"
import { resolve } from "node:path"
import { createTheAudioDbStore } from "../src/metadata/theaudiodb/store"
import type { TheAudioDbResult } from "../src/metadata/theaudiodb/api"
test("mounted artwork honors quiet/offline mode, ABA retirement, config revisions and safe managed candidates", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/theAudioDbArtwork.tsx"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: out + err }).toEqual({ status: 0, output: "" })
})
const identity = {
  scope: "account/library",
  kind: "album" as const,
  artist: "Artist",
  title: "Album",
}
const status = (revision: string) => ({
  revision,
  connectionId: revision,
  baseUrl: "https://www.theaudiodb.com/api/v2/json/",
  enabled: true,
  configured: true,
  hasApiKey: true,
})
const ready = (revision: string): TheAudioDbResult => ({
  status: "ready",
  item: {
    id: "12",
    kind: "album",
    artist: "Artist",
    title: "Album",
    mbid: null,
    revision,
    fields: {
      summary: "Verified description",
      externalUrl: "https://www.theaudiodb.com/album12",
    },
    posters: [],
    backgrounds: [],
    url: "https://www.theaudiodb.com/album12",
  },
})
test("unconfigured source stays quiet; concurrent verified lookups coalesce and scopes stay separate", async () => {
  let calls = 0
  const service = createTheAudioDbStore(
    {
      status: async () => status("A"),
      configure: async () => status("B"),
      lookup: async () => {
        calls++
        return ready("A")
      },
    },
    () => true
  )
  expect(await service.lookup(identity)).toEqual({ status: "unavailable" })
  expect(calls).toBe(0)
  await service.store.getState().load()
  await Promise.all([service.lookup(identity), service.lookup(identity)])
  expect(calls).toBe(1)
  await service.lookup({ ...identity, scope: "other/library" })
  expect(calls).toBe(2)
  service.invalidate(identity)
  await service.lookup(identity)
  expect(calls).toBe(3)
})
test("configuration retirement rejects delayed old results and clears cache without storing keys", async () => {
  let finish!: (value: TheAudioDbResult) => void,
    calls = 0
  const service = createTheAudioDbStore(
    {
      status: async () => status("A"),
      configure: async () => status("B"),
      lookup: async () => {
        calls++
        return calls === 1
          ? new Promise((resolve) => {
              finish = resolve
            })
          : ready("B")
      },
    },
    () => true
  )
  await service.store.getState().load()
  const old = service.lookup(identity)
  await service.store
    .getState()
    .configure({ enabled: true, apiKey: "fictional-key" })
  finish(ready("A"))
  expect(await old).toEqual({ status: "unavailable" })
  expect((await service.lookup(identity)).status).toBe("ready")
  expect(calls).toBe(2)
  expect(JSON.stringify(service.store.getState())).not.toContain(
    "fictional-key"
  )
})
test("wrong MBID/name/revision is not cached as enrichment and failed transport remains retryable", async () => {
  let calls = 0
  const service = createTheAudioDbStore(
    {
      status: async () => status("A"),
      configure: async () => status("B"),
      lookup: async () => {
        calls++
        if (calls === 1) throw new Error("fictional private native error")
        return ready("wrong-revision")
      },
    },
    () => true
  )
  await service.store.getState().load()
  await expect(service.lookup(identity)).rejects.toThrow()
  expect(await service.lookup(identity)).toEqual({ status: "unavailable" })
  expect(calls).toBe(2)
  expect(await service.lookup(identity)).toEqual({ status: "unavailable" })
  expect(calls).toBe(3)
})
test("positive TTL expires, reviewed MBID mismatch stays unavailable and targeted refresh retires old lookup", async () => {
  const originalNow = Date.now
  let now = 1_000,
    calls = 0,
    finish!: (value: TheAudioDbResult) => void
  Date.now = () => now
  try {
    const service = createTheAudioDbStore(
      {
        status: async () => status("A"),
        configure: async () => status("B"),
        lookup: async () => {
          calls++
          return calls === 4
            ? new Promise((resolve) => {
                finish = resolve
              })
            : ready("A")
        },
      },
      () => true
    )
    await service.store.getState().load()
    await service.lookup(identity)
    now += 6 * 60 * 60 * 1000 + 1
    expect(service.peek(identity)).toBeUndefined()
    await service.lookup(identity)
    expect(calls).toBe(2)
    expect(
      await service.lookup(identity, "00000000-0000-4000-8000-000000000001")
    ).toEqual({ status: "unavailable" })
    service.invalidate(identity)
    const old = service.lookup(identity)
    service.invalidate(identity)
    await service.lookup(identity)
    finish(ready("A"))
    expect(await old).toEqual({ status: "unavailable" })
    expect(service.peek(identity)?.status).toBe("ready")
    expect(calls).toBe(5)
  } finally {
    Date.now = originalNow
  }
})
