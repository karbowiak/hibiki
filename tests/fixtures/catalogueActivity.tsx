import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { create } from "zustand"
import type { Activity } from "../../src/activity/model"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test/" })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const library = create(() => ({
  prefetchStatus: null,
  isLoading: false,
  isFetchingMore: false,
  libraryScanning: false,
  libraryScanProgress: null as number | null,
}))
mock.module("../../src/stores/index.ts", () => ({ useLibraryStore: library }))
const background = create(() => ({ rows: [] as Activity[] }))
mock.module("../../src/activity/useBackgroundActivities.ts", () => ({ useBackgroundActivities: () => background(state => state.rows) }))
const routes: string[] = []
mock.module("wouter", () => ({ useLocation: () => ["/", (href: string) => routes.push(href)] }))
const calls: string[] = []
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    calls.push(command)
  },
}))
const { useCatalogueStore } = await import("../../src/offline/catalogueStore")
const { useNotificationCenterStore } =
  await import("../../src/stores/notificationCenterStore")
const { ActivityIndicator } =
  await import("../../src/components/ActivityIndicator")
const context = { cacheScope: `plex-${"a".repeat(64)}`, connectionRevision: 7 }
useCatalogueStore.getState().activate(context)
useCatalogueStore
  .getState()
  .update(context, {
    tasks: [{ task: "track", status: "running" }],
    analysisPending: 1000,
    incremental: { phase: "updating", pending: 2 },
  } as any)
for (const id of ["library.indexing", "library.playlists"])
  useNotificationCenterStore
    .getState()
    .notify({
      id,
      title: "Old mirror warning",
      message: "Retired",
      persistent: true,
      severity: "warning",
    })
const root = createRoot(document.getElementById("root")!)
await act(async () => {
  root.render(<ActivityIndicator />)
})
const opener = document.querySelector("button")!
assert.equal(opener.title, "No active operations")
await act(async () => {
  opener.click()
})
assert(!document.body.textContent!.includes("Saving waveforms"))
assert(!document.body.textContent!.includes("Saving your library"))
assert.deepEqual(
  calls,
  [],
  "opening Activity never starts or retries the old mirror"
)
await act(async () => {
  library.setState({ libraryScanning: true, libraryScanProgress: 50 })
})
assert.equal(opener.title, "1 active operation")
assert.match(document.body.textContent!, /Library scanning · 50%/)
await act(async () => {
  library.setState({ libraryScanning: false })
  background.setState({ rows: [
    { id: "matching", label: "I got the need, for speed!", detail: "Matching YTM\n100 of 307 songs checked\nYTM · 70 available · 60 synced", busy: true,
      progress: { label: "Songs checked", value: 100, total: 307 } },
    { id: "review", label: "Another playlist", detail: "Sync needs review", state: "paused",
      action: { label: "Review sync", href: "/mixed-playlist/example?info=sync" } },
  ] })
})
assert.equal(opener.title, "1 active operation")
assert.match(document.body.textContent!, /70 available · 60 synced/)
assert.equal(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "100")
await act(async () => {
  ;(Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Review sync") as HTMLButtonElement).click()
})
assert.deepEqual(routes, ["/mixed-playlist/example?info=sync"])
assert.equal(document.querySelector('[role="dialog"]'), null)
assert.deepEqual(calls, [], "activity actions only navigate; they never retry an uncertain write")
await act(async () => {
  root.unmount()
})
dom.window.close()
