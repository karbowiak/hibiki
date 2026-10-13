import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { deferred, settle } from "../helpers/radioAudioFakes"
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://synthetic.test",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { createRoot } = await import("react-dom/client")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { AdvancedMetadataPanel } =
  await import("../../src/components/shared/AdvancedMetadataPanel")
await settle()
const snapshot: any = {
  itemId: 12,
  kind: "album",
  fields: {
    sortTitle: { value: "Album", locked: false },
    genres: { value: ["Rock"], locked: true },
    moods: { value: [], locked: null },
    posterLock: { value: "private-fingerprint", locked: false },
  },
}
let writeGate = deferred<void>()
let writes = 0,
  patch: any
const provider: any = {
  cacheScope: "scope",
  playbackSession: 1,
  isOffline: false,
  getAdvancedMetadata: async () => structuredClone(snapshot),
  editAdvancedMetadata: async (_kind: any, _id: any, value: any) => {
    writes++
    patch = value
    await writeGate.promise
  },
}
useProviderStore.setState({ provider })
const savingStates: boolean[] = []
const root = createRoot(document.getElementById("root")!)
await act(async () => {
  root.render(
    <AdvancedMetadataPanel
      kind="album"
      itemId="12"
      onSavingChange={(value) => savingStates.push(value)}
    />
  )
  await settle()
})
assert.equal(
  (document.querySelector('[aria-label="Moods"]') as HTMLTextAreaElement)
    .disabled,
  true
)
assert.equal(document.body.textContent!.includes("private-fingerprint"), false)
const lock = Array.from(document.querySelectorAll("label"))
  .find((label) => label.textContent === "Lock plex poster")!
  .querySelector("input")!
await act(async () => {
  lock.click()
  await settle()
})
const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === name
  )!
await act(async () => {
  button("Review advanced changes").click()
  await settle()
})
await act(async () => {
  const confirm = button("Confirm Plex save")
  confirm.click()
  confirm.click()
  await settle()
})
assert.equal(writes, 1)
assert.deepEqual(patch, {
  expected: { posterLock: { value: "private-fingerprint", locked: false } },
  changes: { posterLock: { value: "private-fingerprint", locked: true } },
})
await act(async () => {
  writeGate.resolve()
  await settle()
})
assert.deepEqual(savingStates, [true, false])
writeGate = deferred<void>()
await act(async () => {
  Array.from(document.querySelectorAll("label"))
    .find((label) => label.textContent === "Lock plex poster")!
    .querySelector("input")!
    .click()
  await settle()
})
await act(async () => {
  button("Review advanced changes").click()
  await settle()
})
await act(async () => {
  button("Confirm Plex save").click()
  await settle()
})
assert.equal(writes, 2)
await act(async () => {
  useProviderStore.setState({ provider: null })
  writeGate.resolve()
  await settle()
})
assert.deepEqual(
  savingStates,
  [true, false, true],
  "retired completion must not release replacement owner's save guard"
)
const oldRead = deferred<any>()
await act(async () => {
  useProviderStore.setState({
    provider: {
      ...provider,
      cacheScope: "retiring",
      getAdvancedMetadata: () => oldRead.promise,
    },
  })
  await settle()
})
await act(async () => {
  useProviderStore.setState({ provider: null })
  oldRead.resolve(snapshot)
  await settle()
})
assert.equal(document.querySelector('[aria-label="Sort title"]'), null)
assert.equal(writes, 2)
await act(() => root.unmount())
dom.window.close()
