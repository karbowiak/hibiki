import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"

const dom = new JSDOM("<div id='root'></div>", {
  url: "https://hibiki.test/stations",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
mock.module("../../src/stores", () => ({
  useLibraryStore: create(() => ({})),
  useConnectionStore: create(() => ({})),
}))
mock.module("../../src/stores/playerStore", () => ({
  usePlayerStore: create(() => ({})),
}))
mock.module("../../src/lib/mixSelection", () => ({
  selectMix() {},
  shuffleTracks() {},
}))
mock.module("../../src/components/MediaCard", () => ({ MediaCard: () => null }))
mock.module("../../src/components/ScrollRow", () => ({ ScrollRow: () => null }))
mock.module("../../src/components/shared/ArtworkImage", () => ({
  ArtworkImage: () => null,
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useContextMenuStore } =
  await import("../../src/stores/contextMenuStore")
const { TagGridMixBuilder } =
  await import("../../src/components/Pages/Stations")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const played: string[] = []
const provider = {
  cacheScope: "test",
  buildTagFilterUri: (_kind: string, tag: string) => tag,
}
useProviderStore.setState({ provider: provider as any })
const tags = Array.from({ length: 14_062 }, (_, index) => ({
  tag: `Genre ${String(index).padStart(5, "0")}`,
  count: null,
}))

async function render(sectionId = 1) {
  await act(async () =>
    root.render(
      <TagGridMixBuilder
        tags={tags}
        tabType="genre"
        sectionUuid="test"
        sectionId={sectionId}
        colorPalette={["bg-blue-700"]}
        playFromUri={async (uri) => {
          played.push(uri)
        }}
      />
    )
  )
}
function tiles() {
  return document.querySelectorAll<HTMLButtonElement>("button[title]")
}
async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`
  )
  assert.ok(button)
  await act(async () => {
    button.click()
  })
}
async function filter(value: string) {
  const input = document.querySelector("input")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value"
    )!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
}

await render()
assert.equal(tiles().length, 96)
assert.equal(tiles()[0].title, "Genre 00000")
assert.equal(
  document.querySelector<HTMLButtonElement>('[aria-label="Previous genres"]')!
    .disabled,
  true
)
await click("Next genres")
assert.equal(tiles().length, 96)
assert.equal(tiles()[0].title, "Genre 00096")
// A match beyond the first 10,000 entries must still be searchable; filtering
// resets pagination and clicking retains the actual tag identity.
await filter("  GENRE 14061  ")
assert.equal(tiles().length, 1)
assert.equal(tiles()[0].title, "Genre 14061")
assert.equal(document.querySelector('[aria-label="Next genres"]'), null)
await act(async () => {
  tiles()[0].click()
})
assert.deepEqual(played, ["Genre 14061"])
await filter("")
assert.equal(tiles().length, 96)
assert.equal(tiles()[0].title, "Genre 00000")
// Replacing the provider/library cannot retain a prior page or action menu.
await click("Next genres")
await act(async () =>
  tiles()[0].dispatchEvent(
    new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })
  )
)
assert.equal(useContextMenuStore.getState().open, true)
await render(2)
assert.equal(tiles()[0].title, "Genre 00000")
assert.equal(useContextMenuStore.getState().open, false)
await act(async () => root.unmount())
dom.window.close()
