import assert from "node:assert/strict"
import { mock } from "bun:test"
import { JSDOM } from "jsdom"
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { create } from "zustand"
const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "https://fixture.test/album/1" }
)
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  history: dom.window.history,
  IS_REACT_ACT_ENVIRONMENT: true,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
const album = {
  id: "1",
  title: "Primary <img src=x>",
  artistName: "Artist",
  year: 2025,
  trackCount: 1,
  _alternateIds: ["2"],
}
let writes = 0
let gets = 0
let attempts = 0
const pending = deferred<any>()
const provider: any = {
  cacheScope: "scope-a",
  playbackSession: {},
  getAlbum: async (id: string) => {
    gets++
    if (process.argv[2] === "retry" && attempts++ === 0)
      throw new Error("https://private.test/?token=secret")
    return process.argv[2] === "readonly" || process.argv[2] === "retry"
      ? { ...album, id, title: "Alternative" }
      : pending.promise
  },
  getAlbumTracks: async () => [
    {
      id: "track",
      title: "Track",
      mediaInfo: {
        versions: [
          {
            mediaId: "10",
            partId: "11",
            versionNumber: 1,
            codec: "flac",
            bitDepth: 24,
            samplingRate: 96000,
            bitrate: 1000,
            fileSize: 1048576,
            selected: true,
          },
        ],
      },
    },
  ],
  rate: async () => writes++,
  deletePlaylist: async () => writes++,
  getPlaybackInfo: async () => writes++,
}
const store = create(() => ({ provider }))
mock.module("../../src/stores/providerStore", () => ({
  useProviderStore: store,
}))
const { VersionReviewPanel } =
  await import("../../src/components/VersionReview/VersionReviewPanel")
const root = createRoot(document.getElementById("root")!)
await act(async () => root.render(<VersionReviewPanel album={album as any} />))
const scenario = process.argv[2]
if (scenario === "readonly") {
  assert(document.body.textContent!.includes("FLAC"))
  assert(document.body.textContent!.includes("Automatic choice"))
  assert.equal(document.querySelectorAll("a").length, 2)
  assert.equal(document.querySelector("img"), null)
  assert.equal(writes, 0)
  assert.equal(gets, 1)
} else if (scenario === "retry") {
  assert(
    document.body.textContent!.includes("Some versions could not be loaded")
  )
  assert(!document.body.textContent!.includes("secret"))
  const retry = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Retry version details"
  )!
  await act(async () => retry.click())
  assert(document.body.textContent!.includes("Alternative"))
  assert(!document.body.textContent!.includes("Some versions"))
  assert.equal(writes, 0)
} else if (scenario === "provider") {
  await act(async () => {
    store.setState({
      provider: { ...provider, cacheScope: "scope-b", playbackSession: {} },
    })
    root.render(<VersionReviewPanel album={album as any} />)
  })
  await act(async () =>
    pending.resolve({ ...album, id: "2", title: "OLD ACCOUNT" })
  )
  assert(document.body.textContent!.includes("library changed"))
  assert(!document.body.textContent!.includes("OLD ACCOUNT"))
  assert(!document.body.textContent!.includes("Primary"))
  assert.equal(gets, 1)
} else if (scenario === "scope") {
  provider.cacheScope = "scope-b"
  await act(async () =>
    root.render(<VersionReviewPanel album={album as any} />)
  )
  await act(async () =>
    pending.resolve({ ...album, id: "2", title: "OLD ACCOUNT" })
  )
  assert(document.body.textContent!.includes("library changed"))
  assert(!document.body.textContent!.includes("OLD ACCOUNT"))
  assert.equal(gets, 1)
} else if (scenario === "unmount") {
  await act(async () => root.unmount())
  await act(async () =>
    pending.resolve({ ...album, id: "2", title: "OLD ACCOUNT" })
  )
  assert.equal(document.getElementById("root")!.textContent, "")
  assert.equal(writes, 0)
} else throw new Error("Unknown fixture scenario")
if (scenario !== "unmount") await act(async () => root.unmount())
dom.window.close()
