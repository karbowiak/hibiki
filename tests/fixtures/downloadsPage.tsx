import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { create } from "zustand"
import { deferred, settle } from "../helpers/radioAudioFakes"
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://hibiki.test/downloads",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const providerStore = create<any>(() => ({ provider: null }))
let played: string | null = null
mock.module("../../src/stores/providerStore", () => ({
  useProviderStore: providerStore,
}))
mock.module("../../src/stores/playerStore", () => ({
  usePlayerStore: create(() => ({
    playTrack: async (track: any) => {
      played = track.id
    },
  })),
}))
mock.module("../../src/hooks/useContextMenu", () => ({
  useContextMenu: () => ({ handler: () => () => {} }),
}))
mock.module("../../src/components/shared/ArtworkImage", () => ({
  ArtworkImage: () => null,
}))
const { DownloadsPage } = await import("../../src/components/Pages/Downloads")
const root = createRoot(document.getElementById("root")!)
const removal = deferred<void>(),
  oldRead = deferred<any>()
let removals = 0
const ready: any = {
  trackId: 1,
  track: {
    id: "1",
    title: "Ready song",
    artistName: "Artist",
    albumName: "Album",
  },
  status: "downloaded",
  received: 100,
  total: 100,
  error: null,
  available: true,
}
const missing: any = {
  ...ready,
  trackId: 2,
  track: { ...ready.track, id: "2", title: "Missing song" },
  status: "unavailable",
  available: false,
}
const provider: any = {
  getLocalAudio: async () => ({
    items: [ready, missing],
    total: 2,
    downloadedBytes: 100,
  }),
  removeDownload: () => {
    removals++
    return removal.promise
  },
  downloadTracks: async () => {},
}
function button(label: string) {
  const result = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`
  )
  assert(result, label)
  return result
}
await act(async () => {
  providerStore.setState({ provider })
  root.render(<DownloadsPage />)
  await settle()
})
assert.equal(button("Play Ready song").disabled, false)
assert.equal(button("Play Missing song").disabled, true)
await act(async () => {
  button("Play Ready song").click()
  await settle()
})
assert.equal(played, "1")
await act(async () => {
  button("Remove download of Ready song").click()
  button("Remove download of Ready song").click()
  await settle()
})
assert.equal(removals, 1)
assert.equal(button("Remove download of Ready song").disabled, true)
const other: any = {
  getLocalAudio: () => oldRead.promise,
  removeDownload: async () => {},
}
await act(async () => {
  providerStore.setState({ provider: other })
  await settle()
})
assert(!document.body.textContent?.includes("Ready song"))
await act(async () => {
  providerStore.setState({
    provider: {
      getLocalAudio: async () => ({ items: [], total: 0, downloadedBytes: 0 }),
    },
  })
  await settle()
})
await act(async () => {
  oldRead.resolve({ items: [ready], total: 1, downloadedBytes: 100 })
  removal.resolve()
  await settle()
})
assert(!document.body.textContent?.includes("Ready song"))
assert(document.body.textContent?.includes("Take your music with you"))
await act(() => root.unmount())
dom.window.close()
