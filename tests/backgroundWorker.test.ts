import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyFavorites } from "../src/favorites/model"
import { trackBackgroundCall, useBackgroundCallStore } from "../src/background/status"
import {
  newestRatings,
  newestRows,
  StateSnapshots,
  PendingCalls,
  workerData,
  type FromWorker,
  type ToWorker,
} from "../src/background/protocol"

test("concurrent queue admissions share only their in-flight owner and arguments", async () => {
  const calls = new PendingCalls()
  let release!: (value: number) => void, count = 0
  const work = () => { count++; return new Promise<number>(resolve => { release = resolve }) }
  const first = calls.run("owner:playlist:one", work)
  const second = calls.run("owner:playlist:one", work)
  expect(first).toBe(second)
  await Promise.resolve()
  expect(count).toBe(1)
  expect(await calls.run("other:playlist:one", async () => 2)).toBe(2)
  expect(await calls.run("owner:playlist:two", async () => 3)).toBe(3)
  release(1)
  expect(await first).toBe(1)
  expect(await calls.run("owner:playlist:one", async () => 4)).toBe(4)
  await expect(calls.run("failed", async () => { throw Error("not admitted") })).rejects.toThrow("not admitted")
  expect(await calls.run("failed", async () => 5)).toBe(5)
})

test("playlist admission stays visible until all coalesced callers finish", async () => {
  let releaseFirst!: () => void, releaseSecond!: () => void
  const first = trackBackgroundCall("mixed", "playlist", () => new Promise<void>(resolve => { releaseFirst = resolve }))
  const second = trackBackgroundCall("mixed", "playlist", () => new Promise<void>(resolve => { releaseSecond = resolve }))
  expect(useBackgroundCallStore.getState().pending["mixed:playlist"]).toBe(2)
  releaseFirst(); await first
  expect(useBackgroundCallStore.getState().pending["mixed:playlist"]).toBe(1)
  releaseSecond(); await second
  expect(useBackgroundCallStore.getState().pending["mixed:playlist"]).toBeUndefined()
  await expect(trackBackgroundCall("mixed", "playlist", async () => { throw Error("not admitted") })).rejects.toThrow("not admitted")
  expect(useBackgroundCallStore.getState().pending["mixed:playlist"]).toBeUndefined()
})

test("worker state patches skip unchanged collections and preserve unsent local edits", () => {
  const snapshots = new StateSnapshots()
  let visits = 0
  const playlists = Array.from({ length: 1000 }, (_, id) => ({
    id: String(id),
    revision: 1,
    get title() {
      visits++
      return "Playlist"
    },
  }))
  const first = {
    playlists,
    running: false,
    error: "old",
    provider: { token: "private" },
  }
  expect(Object.keys(snapshots.take("mixed", first)!)).toEqual([
    "playlists",
    "running",
    "error",
  ])
  expect(visits).toBe(1000)
  const busy = { ...first, running: true }
  expect(snapshots.take("mixed", busy)).toEqual({ running: true })
  expect(snapshots.take("mixed", busy)).toBeUndefined()
  expect(visits).toBe(1000)
  const local = { ...busy, playlists: [{ id: "new", revision: 2 }] }
  const received = { ...local, error: undefined }
  snapshots.received("mixed", local, received)
  expect(snapshots.take("mixed", received)).toEqual({
    playlists: local.playlists,
  })
  expect(snapshots.take("mixed", { ...received, error: "retry" })).toEqual({
    error: "retry",
  })
  expect(snapshots.take("mixed", received)).toEqual({ error: undefined })
  snapshots.clear()
  expect(snapshots.take("mixed", received)).toHaveProperty("playlists")
})

test("merging large journal rosters reads identities linearly", () => {
  let reads = 0
  const rows = Array.from({ length: 2000 }, (_, id) => ({
    get id() {
      reads++
      return String(id)
    },
    revision: 1,
  }))
  const newer = rows.map((row) => ({ id: row.id, revision: 2 }))
  reads = 0
  expect(newestRows(rows, newer)).toEqual(newer)
  expect(reads).toBeLessThanOrEqual(rows.length * 3)
})

test("worker publications cannot echo a local favorite sync request back to the client", () => {
  const snapshots = new StateSnapshots()
  const first = snapshots.take("favorites", { collection: emptyFavorites(), running: false, syncRequest: 4 })!
  expect(first.syncRequest).toBeUndefined()
  const worker = new StateSnapshots()
  expect(worker.take("favorites", { ...first, syncRequest: 0 })?.syncRequest).toBeUndefined()
})

test("renderer bridge delivers asynchronous replies only to their original worker", async () => {
  // Keep module mocks out of the real worker/domain tests in this process.
  const child = Bun.spawn(
    [process.execPath, "test", "./tests/fixtures/backgroundRuntime.fixture.ts"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code) throw Error(`${stdout}\n${stderr}`)
})

test("worker snapshots exclude executable references and preserve structured data and newer revisions", () => {
  const clone = workerData({
    provider: { token: "private" },
    session: Symbol(),
    running: { song: { current: () => true } },
    ids: new Set(["one"]),
    ratings: new Map([["one", 8]]),
    rows: [{ id: "x", revision: 3 }],
  })
  expect(structuredClone(clone)).toEqual({
    running: { song: {} },
    ids: new Set(["one"]),
    ratings: new Map([["one", 8]]),
    rows: [{ id: "x", revision: 3 }],
  })
  expect(
    newestRows(
      [
        { id: "x", revision: 3 },
        { id: "new", revision: 1 },
      ],
      [{ id: "x", revision: 2 }]
    )
  ).toEqual([
    { id: "x", revision: 3 },
    { id: "new", revision: 1 },
  ])
})

test("late rating acknowledgements cannot undo a newer exact-star intention", () => {
  const current = { song: { id: "new", changedAt: 20, value: 10, saved: {} } }
  expect(
    newestRatings(current, {
      song: {
        id: "old",
        changedAt: 10,
        value: 2,
        saved: { ytmusic: "account" },
      },
    })
  ).toEqual(current)
  expect(
    newestRatings(
      { song: { ...current.song, saved: { plex: "library" } } },
      { song: { ...current.song, saved: { ytmusic: "account" } } }
    ).song.saved
  ).toEqual({ plex: "library", ytmusic: "account" })
})

test("reconciliation worker boots independently, rejects retired owners, and completes empty domain jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hibiki-worker-"))
  let worker: Worker | undefined
  try {
    // Compile only this worker to a temporary fixture; no Cargo/Vite server or app build.
    const result = await Bun.build({
      entrypoints: ["src/background/worker.ts"],
      outdir: directory,
      target: "browser",
      format: "esm",
      splitting: true,
      define: {
        "import.meta.env": JSON.stringify({
          DEV: false,
          TAURI_ENV_PLATFORM: "darwin",
        }),
      },
    })
    if (!result.success) throw Error(result.logs.map(String).join("\n"))
    const entry = result.outputs.find(
      (output) => output.kind === "entry-point"
    )!
    const pending: {
      accept(message: FromWorker): boolean
      resolve(message: FromWorker): void
      reject(error: Error): void
    }[] = []
    const seen: FromWorker[] = []
    const wait = (accept: (message: FromWorker) => boolean) =>
      new Promise<FromWorker>((resolve, reject) => {
        const found = seen.find(accept)
        if (found) return resolve(found)
        const item = {
          accept,
          resolve: (message: FromWorker) => {
            clearTimeout(timeout)
            resolve(message)
          },
          reject,
        }
        const timeout = setTimeout(
          () => reject(Error("Worker fixture timed out")),
          5000
        )
        pending.push(item)
      })
    worker = new Worker(entry.path)
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data
      if (message.type === "fault")
        for (const item of pending.splice(0))
          item.reject(Error(message.message))
      seen.push(message)
      for (let i = pending.length - 1; i >= 0; i--)
        if (pending[i].accept(message)) pending.splice(i, 1)[0].resolve(message)
    }
    worker.onerror = (event) => {
      for (const item of pending.splice(0)) item.reject(Error(event.message))
    }
    await wait((message) => message.type === "ready")
    const send = (message: ToWorker) => worker!.postMessage(message)
    const loggedOut = {
      isAuthenticated: false,
      isEnabled: false,
      username: null,
    }
    send({
      type: "context",
      context: {
        owner: "current",
        provider: null,
        youtube: { connected: false, revision: 0 },
        lastfm: loggedOut,
        listenbrainz: loggedOut,
      },
    })
    send({
      type: "run",
      job: {
        token: "old",
        request: {
          owner: "old",
          domain: "mixed",
          method: "retryIndexedMatches",
          args: [],
        },
      },
    })
    expect(
      await wait(
        (message) => message.type === "finished" && message.token === "old"
      )
    ).toMatchObject({ error: "Music accounts changed." })
    for (const [domain, method] of [
      ["mixed", "retryIndexedMatches"],
      ["favorites", "sync"],
      ["ratings", "resume"],
    ] as const) {
      send({
        type: "run",
        job: {
          token: domain,
          request: { owner: "current", domain, method, args: [] },
        },
      })
      expect(
        await wait(
          (message) => message.type === "finished" && message.token === domain
        )
      ).toMatchObject({ result: null })
    }
    // YTM collection jobs need no Plex provider, and fetch through the native
    // browsing cache directly rather than queueing a second worker job.
    send({ type: "context", context: { owner: "current", provider: null,
      youtube: { connected: true, revision: 1, accountId: "youtube" }, lastfm: loggedOut, listenbrainz: loggedOut } })
    send({ type: "run", job: { token: "youtube-cache", request: {
      owner: "current", domain: "collections", method: "hydrateYoutubeMusic",
      args: [{ key: "ytmusic:playlist:VLone", id: "VLone", title: "Saved playlist",
        owner: { revision: 1, accountId: "youtube" } }],
    } } })
    const listener = await wait(message => message.type === "rpc" && message.method === "plugin:event|listen" &&
      message.args.event === "ytmusic://catalog")
    if (listener.type !== "rpc") throw Error("Missing catalog listener")
    send({ type: "reply", id: listener.id, value: 1 })
    const browse = await wait(message => message.type === "rpc" && message.method === "ytmusic_browse")
    if (browse.type !== "rpc") throw Error("Missing native browse")
    expect(browse.args).toMatchObject({ browseId: "VLone", continuation: null, force: false, background: false, clientRevision: 1 })
    send({ type: "reply", id: browse.id, value: { title: "Saved playlist", items: [], hubs: [], continuation: "next" } })
    const nextPage = await wait(message => message.type === "rpc" && message.method === "ytmusic_browse" && message.id !== browse.id)
    if (nextPage.type !== "rpc") throw Error("Missing continuation browse")
    expect(nextPage.args.continuation).toBe("next")
    send({ type: "reply", id: nextPage.id, value: { title: "Saved playlist", items: [], hubs: [], continuation: null } })
    expect(await wait(message => message.type === "finished" && message.token === "youtube-cache"))
      .toMatchObject({ result: { done: true } })
    expect(seen.some(message => message.type === "progress" && message.token === "youtube-cache" &&
      message.progress.stage === "Caching YTM playlist" && message.progress.current === "Saved playlist")).toBe(true)
    const plex = {
      data: {
        name: "Plex",
        cacheScope: "library",
        capabilities: {},
        isOffline: false,
      },
      methods: [],
      favorites: ["load", "page"],
    }
    const connection = {
      owner: "current",
      provider: plex,
      youtube: { connected: false, revision: 0 },
      lastfm: loggedOut,
      listenbrainz: loggedOut,
    }
    // Bind a new provider owner, then change only metadata while its read waits.
    connection.owner = "plex-owner"
    send({ type: "context", context: connection })
    send({
      type: "run",
      job: {
        token: "favorites-load",
        request: {
          owner: connection.owner,
          domain: "favorites",
          method: "sync",
          args: [],
        },
      },
    })
    const first = await wait(
      (message) => message.type === "rpc" && message.method === "favorites.load"
    )
    if (first.type !== "rpc") throw Error("Missing provider request")
    // A slow favorites read must not monopolize all reconciliation domains.
    send({
      type: "run",
      job: {
        token: "independent-rating",
        request: {
          owner: connection.owner,
          domain: "ratings",
          method: "resume",
          args: [],
        },
      },
    })
    expect(
      await wait(
        (message) =>
          message.type === "finished" && message.token === "independent-rating"
      )
    ).toMatchObject({ result: null })
    const metadata = {
      ...emptyFavorites(),
      ratingsImported: true,
      settings: emptyFavorites().settings,
    }
    send({
      type: "context",
      context: {
        ...connection,
        youtube: { ...connection.youtube, revision: 1 },
      },
    })
    send({
      type: "reply",
      id: first.id,
      value: { revision: 0, total: 0, metadata },
    })
    const verified = await wait(
      (message) =>
        message.type === "rpc" &&
        message.method === "favorites.load" &&
        message.id !== first.id
    )
    if (verified.type !== "rpc") throw Error("Missing profile verification")
    send({
      type: "reply",
      id: verified.id,
      value: { revision: 0, total: 0, metadata },
    })
    const completed = await wait(
      (message) =>
        message.type === "finished" && message.token === "favorites-load"
    )
    expect(completed).toMatchObject({ result: null })
    expect(
      seen.some(
        (message) =>
          message.type === "state" &&
          message.domain === "favorites" &&
          message.data.loaded
      )
    ).toBe(true)
  } finally {
    worker?.terminate()
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

test("queued collection hydration yields between bounded turns, resumes its generation, and retains track types", async () => {
  const { hydrateCollection } = await import("../src/offline/hydrateCollection")
  let offset = 0,
    committed = 0
  const progress: number[] = []
  const native = async (op: string, args: any): Promise<any> => {
    if (op === "info") return null
    if (op === "begin") return { generation: 1, offset, ...(offset ? { total: 2500 } : {}) }
    if (op === "put") {
      expect(args.offset).toBe(offset)
      expect(
        args.items.every(
          (item: any) => item.type === "track" && !item._providerData
        )
      ).toBe(true)
      offset += args.items.length
    }
    if (op === "commit") {
      committed++
      return { changed: true }
    }
  }
  const deps = {
    native,
    progress: (done: number) => progress.push(done),
    read: async (_method: string, args: any[]) => {
      const offset = args[1]
      return {
        total: 2500,
        offset,
        items: Array.from({ length: 500 }, (_, index) => ({
          id: String(offset + index),
          title: "Song",
          _providerData: { secret: "private" },
        })),
      }
    },
  }
  const job = {
    context: { cacheScope: "scope", connectionRevision: 1 },
    key: "playlist:1",
    stamp: "a",
    force: true,
    source: { kind: "playlist" as const, id: "1" },
  }
  expect(await hydrateCollection(job, deps)).toEqual({
    done: false,
    changed: false,
    resume: { completed: 2000, total: 2500 },
  })
  expect(offset).toBe(2000)
  expect(committed).toBe(0)
  expect(await hydrateCollection(job, deps)).toEqual({
    done: true,
    changed: true,
  })
  expect(progress).toEqual([0, 500, 1000, 1500, 2000, 2000, 2500])
  expect(committed).toBe(1)
})
