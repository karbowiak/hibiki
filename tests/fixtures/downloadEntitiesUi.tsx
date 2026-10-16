import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { deferred, settle } from "../helpers/radioAudioFakes"
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://hibiki.test/library",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  location: dom.window.location,
  history: dom.window.history,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const calls: any[] = [],
  late = deferred<any>()
let hold = false,
  ready = true
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: any) => {
    calls.push({ command, args })
    if (command === "download_entity_status")
      return hold
        ? late.promise
        : args.entities.map((item: any) => ({
            ...item,
            known: true,
            total: 2,
            downloaded: ready ? 2 : 1,
            pending: 0,
            failed: ready ? 0 : 1,
            requested: item.id !== 102,
          }))
    if (command === "download_entity" || command === "remove_entity_download")
      return 2
    throw Error("Unexpected command")
  },
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useCatalogueStore } = await import("../../src/offline/catalogueStore")
const { useDownloadStatusStore, refreshDownloadStatuses } =
  await import("../../src/offline/downloadStatusStore")
const { DownloadBadge } =
  await import("../../src/components/shared/DownloadBadge")
const { DownloadMenuItems } =
  await import("../../src/components/shared/DownloadMenuItems")
const { DownloadStorageControls } =
  await import("../../src/components/DownloadStorageControls")
const scope = `plex-${"a".repeat(64)}`
const provider: any = {
  cacheScope: scope,
  capabilities: {},
  playbackSession: {},
  getLocalAudio: async () => ({
    items: [],
    total: 90,
    downloadedBytes: 2 * 1024 ** 3,
  }),
}
useProviderStore.getState().setProvider(provider)
useCatalogueStore
  .getState()
  .activate({ connectionRevision: 7, cacheScope: scope })
let closes = 0,
  current = true
const root = createRoot(document.getElementById("root")!)
const render = () =>
  root.render(
    <>
      <DownloadBadge kind="album" id="42" />
      <DownloadBadge kind="album" id="42" />
      <DownloadBadge kind="artist" id="generated" />
      <DownloadBadge intentOnly kind="playlist" id="101" />
      <DownloadBadge intentOnly kind="playlist" id="102" />
      <DownloadMenuItems
        kind="artist"
        id="8"
        title="Artist"
        close={() => {
          closes++
        }}
        current={() => current}
      />
      <DownloadStorageControls />
    </>
  )
await act(async () => {
  render()
  await settle()
})
const statusCalls = calls.filter((c) => c.command === "download_entity_status")
assert.equal(
  statusCalls[0].args.entities.filter((i: any) => i.id === 42).length,
  1,
  "duplicate visible badges coalesce"
)
assert(
  !statusCalls.some((c) =>
    c.args.entities.some((i: any) => i.id === "generated")
  )
)
assert.equal(
  document.querySelectorAll(
    '[role=img][aria-label="Downloaded · 2 tracks available offline"]'
  ).length,
  2
)
assert.equal(
  document.querySelectorAll('[aria-label="Saved for offline listening"]')
    .length,
  1,
  "shared cached tracks must not put download badges on an unrequested playlist"
)
assert.match(document.body.textContent!, /2.0 GB/)
assert(
  !document.body.textContent!.includes("90"),
  "storage does not call queued intentions downloaded tracks"
)
let button = [...document.querySelectorAll("button")].find(
  (b) => b.textContent === "Remove download"
)!
assert(button)
await act(async () => {
  button.click()
  button.click()
  await settle()
})
assert.equal(
  calls.filter((c) => c.command === "remove_entity_download").length,
  1,
  "duplicate mutation is fenced"
)
assert.equal(closes, 1)
ready = false
await act(async () => {
  refreshDownloadStatuses()
  await settle()
})
assert(
  document.querySelector(
    '[aria-label="1 of 2 tracks downloaded · 1 need attention"]'
  )
)
button = [...document.querySelectorAll("button")].find(
  (b) => b.textContent === "Download missing tracks"
)!
assert(button)
await act(async () => {
  button.click()
  await settle()
})
assert.equal(
  calls.find((c) => c.command === "download_entity").args.kind,
  "artist"
)
// A retired account never restores an old badge or old storage count.
hold = true
await act(async () => {
  refreshDownloadStatuses()
  await settle()
})
await act(async () => {
  useProviderStore.getState().setProvider({
    cacheScope: `plex-${"b".repeat(64)}`,
    capabilities: {},
  } as any)
  await settle()
})
assert.equal(document.querySelector("[role=img]"), null)
assert.deepEqual(useDownloadStatusStore.getState().statuses, {})
await act(async () => {
  late.resolve([
    {
      kind: "album",
      id: 42,
      known: true,
      total: 2,
      downloaded: 2,
      requested: true,
    },
  ])
  await settle()
})
assert.deepEqual(useDownloadStatusStore.getState().statuses, {})
assert(!document.body.textContent!.includes("2.0 GB"))
await act(async () => root.unmount())
dom.window.close()
