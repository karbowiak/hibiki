import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { create } from "zustand"
import { settle } from "../helpers/radioAudioFakes"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test/" })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
mock.module("../../src/stores/index.ts", () => ({
  useLibraryStore: create(() => ({
    prefetchStatus: null,
    isLoading: false,
    isFetchingMore: false,
    libraryScanning: false,
    libraryScanProgress: null,
  })),
}))
const calls: any[] = []
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: any) => {
    calls.push({ command, args })
  },
}))
const { useCatalogueStore } = await import("../../src/offline/catalogueStore")
const { useOfflineStatusStore } = await import("../../src/offline/statusStore")
const { useNotificationCenterStore } =
  await import("../../src/stores/notificationCenterStore")
const { ActivityIndicator } =
  await import("../../src/components/ActivityIndicator")
const { OfflineStatus } = await import("../../src/components/OfflineStatus")
const scope = `plex-${"a".repeat(64)}`,
  context = { cacheScope: scope, connectionRevision: 7 }
useCatalogueStore.getState().activate(context)
const progress: any = {
  tasks: [{ task: "track", status: "running", cursor: 25, total: 100 }],
  entities: 25,
  details: 4,
  waveforms: 3,
  analysisPending: 10,
  analysisUnavailable: 1,
}
useCatalogueStore.getState().update(context, progress)
const root = createRoot(document.getElementById("root")!)
await act(async () => {
  root.render(
    <>
      <OfflineStatus />
      <ActivityIndicator />
    </>
  )
  await settle()
})
assert(
  !document.body.textContent!.includes("Saving your library"),
  "background progress is not a global banner"
)
const opener = document.querySelector("button")!
assert.equal(opener.title, "2 active operations")
await act(async () => {
  opener.click()
  await settle()
})
assert.equal(opener.getAttribute("aria-expanded"), "true")
assert.match(
  document.querySelector("[role=dialog]")!.textContent!,
  /Tracks: 25 \/ 100/
)
assert.match(
  document.querySelector("[role=dialog]")!.textContent!,
  /25 items saved/
)
assert.match(
  document.querySelector("[role=dialog]")!.textContent!,
  /3 saved · 10 remaining/
)
await act(async () => {
  useCatalogueStore.getState().update(context, {
    ...progress,
    tasks: [
      { task: "catchup:track", status: "running", cursor: 2, total: 10 },
      ...progress.tasks,
    ],
    incremental: {
      pending: 3,
      catchUpRequested: true,
      watermark: 1770000000,
      changesRevision: 1,
      phase: "catchingUp",
    },
  })
  await settle()
})
assert.match(
  document.querySelector("[role=dialog]")!.textContent!,
  /Checking Plex for changes/
)
assert.match(
  document.querySelector("[role=dialog]")!.textContent!,
  /3 items awaiting updates/
)
assert.equal(opener.title, "3 active operations")
assert.match(
  document.querySelector("[role=dialog]")!.textContent!,
  /Tracks: 25 \/ 100/,
  "catch-up progress must not hide initial import progress"
)
await act(async () => {
  useCatalogueStore.getState().update(context, {
    ...progress,
    tasks: [
      { task: "playlist:7", status: "error", cursor: 200, total: 304 },
      ...progress.tasks,
    ],
  })
  await settle()
})
const playlistPanel = document.querySelector("[role=dialog]")!.textContent!
assert.match(playlistPanel, /Saving your library/)
assert.match(playlistPanel, /Tracks: 25 \/ 100/)
assert.match(playlistPanel, /Playlist contents waiting to update/)
assert.match(playlistPanel, /1 playlist will retry automatically/)
assert(!playlistPanel.includes("Library indexing needs attention"))
assert.equal(opener.title, "2 active operations")
assert.equal(
  useNotificationCenterStore
    .getState()
    .notifications.find((n) => n.id === "library.indexing")?.active,
  undefined
)
assert.equal(
  useNotificationCenterStore
    .getState()
    .notifications.find((n) => n.id === "library.playlists")?.active,
  true
)
await act(async () => {
  useCatalogueStore.getState().update(context, {
    ...progress,
    tasks: [
      { ...progress.tasks[0], status: "complete" },
      { task: "analysis:fetch", status: "running", cursor: 0, total: null },
    ],
  })
  await settle()
})
assert.match(
  document.querySelector("[role=dialog]")!.textContent!,
  /Library saved on this device/
)
assert.match(
  document.querySelector("[role=dialog]")!.textContent!,
  /Saving waveforms/
)
assert(
  !document
    .querySelector("[role=dialog]")!
    .textContent!.includes("Saving your library")
)
assert.equal(opener.title, "1 active operation")
await act(async () => {
  useCatalogueStore.getState().update(context, {
    ...progress,
    tasks: progress.tasks.map((task: any) => ({ ...task, status: "complete" })),
    analysisPending: 0,
    incremental: {
      pending: 0,
      catchUpRequested: true,
      watermark: 1770000000,
      changesRevision: 2,
      phase: "idle",
    },
  })
  await settle()
})
assert.equal(opener.title, "No active operations")
assert.match(
  document.querySelector("[role=dialog]")!.textContent!,
  /Library update scheduled/
)
assert(
  !document
    .querySelector("[role=dialog]")!
    .textContent!.includes("Checking Plex for changes")
)
assert.equal(
  document.querySelectorAll(".animate-spin").length,
  0,
  "a queued future check must not spin as active work"
)
await act(async () => {
  useCatalogueStore.getState().update(context, {
    ...progress,
    tasks: [
      {
        task: "playlist:7",
        status: "running",
        cursor: 304,
        total: 304,
        scanMode: "verify",
        keyCursor: 150,
      },
    ],
  })
  await settle()
})
assert.match(
  document.querySelector("[role=dialog]")!.textContent!,
  /Verifying playlist contents: 150 \/ 304/
)
await act(async () => {
  useCatalogueStore.getState().update(context, {
    ...progress,
    tasks: [
      { ...progress.tasks[0], status: "complete" },
      { task: "analysis:fetch", status: "error", cursor: 0, total: null },
    ],
  })
  await settle()
})
assert.match(
  document.querySelector("[role=dialog]")!.textContent!,
  /Waveform collection needs attention/
)
assert(
  !document
    .querySelector("[role=dialog]")!
    .textContent!.includes("Library indexing needs attention")
)
await act(async () => {
  useCatalogueStore.getState().update(context, {
    ...progress,
    tasks: [{ ...progress.tasks[0], status: "error" }],
  })
  await settle()
})
assert.equal(
  useNotificationCenterStore
    .getState()
    .notifications.find((n) => n.id === "library.indexing")?.active,
  true
)
assert.equal(
  useNotificationCenterStore
    .getState()
    .notifications.find((n) => n.id === "library.playlists")?.active,
  false
)
const retry = [...document.querySelectorAll("button")].find(
  (b) => b.textContent === "Retry indexing"
)!
assert(retry)
await act(async () => {
  retry.click()
  await settle()
})
assert.deepEqual(calls, [
  { command: "catalogue_retry", args: { context, reset: false } },
])
await act(async () => {
  useOfflineStatusStore.getState().activate(scope, true)
  await settle()
})
assert(
  ![...document.querySelectorAll("button")].some(
    (b) => b.textContent === "Retry indexing"
  ),
  "offline never offers a remote retry"
)
await act(async () => {
  document.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    })
  )
  await settle()
})
assert.equal(document.querySelector("[role=dialog]"), null)
assert.equal(document.activeElement, opener)
await act(async () => {
  useCatalogueStore.getState().activate(null)
  await settle()
})
assert.equal(
  useNotificationCenterStore
    .getState()
    .notifications.find((n) => n.id === "library.indexing")?.active,
  false
)
await act(async () => root.unmount())
dom.window.close()
