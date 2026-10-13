import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://synthetic.test",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
mock.module("../../src/metadata", () => ({
  getMetadataBackend: () => undefined,
}))
mock.module("../../src/backends/plex/definition", () => ({
  plexBackend: { SettingsComponent: () => <p>Plex connection</p> },
}))
mock.module("../../src/metadata/lastfm/authStore", () => ({
  useLastfmStore: create(() => ({ hasApiKey: false })),
}))
const { createSoulSyncStore } =
  await import("../../src/metadata/soulsync/store")
const { createConfiguredMetadataServiceStore } =
  await import("../../src/metadata/services/store")
const { createTheAudioDbStore } =
  await import("../../src/metadata/theaudiodb/store")
const connection = {
  revision: "one",
  baseUrl: "https://synthetic.test/",
  configured: true,
  hasApiKey: true,
  enabled: true,
}
let releaseSave: (value: typeof connection) => void = () => {}
let saved: any
let writes = 0
const soul = createSoulSyncStore(
  {
    status: async () => connection,
    configure: (args) => {
      writes++
      saved = args
      return new Promise((resolve) => {
        releaseSave = resolve
      })
    },
  },
  () => true
)
const fakeService = {
  status: async () => connection,
  configure: async () => connection,
}
const fanart = createConfiguredMetadataServiceStore(
  "fanart",
  fakeService,
  () => true
)
const heya = createConfiguredMetadataServiceStore(
  "heya",
  fakeService,
  () => true
)
const { store: audio } = createTheAudioDbStore(
  { ...fakeService, lookup: async () => ({ status: "unavailable" }) },
  () => true
)
mock.module("../../src/metadata/soulsync/store", () => ({
  useSoulSyncStore: soul,
}))
mock.module("../../src/metadata/services/store", () => ({
  useFanartServiceStore: fanart,
  useHeyaServiceStore: heya,
}))
mock.module("../../src/metadata/theaudiodb/store", () => ({
  useTheAudioDbStore: audio,
}))
const { useMetadataSourceStore, normalizeMetadataPriority } =
  await import("../../src/stores/metadataSourceStore")
const normalized = normalizeMetadataPriority([
  "heya",
  "retired-source",
  "heya",
  "plex",
])
assert.equal(normalized[0], "heya")
assert.equal(normalized[1], "plex")
assert.equal(new Set(normalized).size, normalized.length)
assert.equal(normalized.filter((item) => item === "soulsync").length, 1)
assert.ok(!normalized.includes("retired-source" as any))
useMetadataSourceStore.setState({ priority: normalized })
const { MetadataPriorityList } =
  await import("../../src/components/Settings/MetadataPriorityList")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const settle = async () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
await act(async () => root.render(<MetadataPriorityList />))
await settle()
assert.equal(
  document.querySelectorAll("input").length,
  0,
  "connection forms do not clutter the priority page"
)
for (const label of ["SoulSync", "Fanart.tv", "HeyaMetadata", "TheAudioDB"])
  assert.ok(button(`Configure ${label}`))
const trigger = button("Configure SoulSync")
trigger.focus()
await act(async () => trigger.click())
await settle()
assert.ok(document.querySelector("dialog"))
assert.equal(
  document.querySelector<HTMLInputElement>('input[type="password"]')!.value,
  "",
  "stored keys are never returned to the modal"
)
assert.ok(document.body.textContent!.includes("Save connection"))
assert.equal(
  writes,
  0,
  "opening a configuration never saves or contacts a metadata provider"
)
await act(async () =>
  document
    .querySelector("form")!
    .dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true })
    )
)
assert.equal(writes, 1)
assert.equal(saved.apiKey, null, "blank retains the same-server native key")
const close = button("Close SoulSync")
assert.equal(
  close.disabled,
  true,
  "configuration receipt cannot be discarded during save"
)
await act(async () =>
  document
    .querySelector("dialog")!
    .dispatchEvent(new dom.window.Event("cancel", { cancelable: true }))
)
assert.ok(document.querySelector("dialog"))
await act(async () => releaseSave({ ...connection, revision: "two" }))
await settle()
assert.equal(button("Close SoulSync").disabled, false)
await act(async () => button("Close SoulSync").click())
assert.equal(document.querySelector("dialog"), null)
assert.equal(
  document.activeElement,
  trigger,
  "closing restores the Configure button focus"
)
const grip = button("Reorder SoulSync")
grip.focus()
const previous = useMetadataSourceStore.getState().priority.indexOf("soulsync")
await act(async () =>
  grip.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    })
  )
)
assert.equal(
  useMetadataSourceStore.getState().priority.indexOf("soulsync"),
  previous - 1
)
assert.equal(document.activeElement, grip)
await act(async () => button("Configure Fanart.tv").click())
await settle()
assert.ok(document.body.textContent!.includes("Project API key"))
assert.ok(!document.querySelector("dialog")!.textContent!.includes("SoulSync"))
await act(async () =>
  document
    .querySelector("dialog")!
    .dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    )
)
assert.equal(document.querySelector("dialog"), null)
await act(async () => root.unmount())
