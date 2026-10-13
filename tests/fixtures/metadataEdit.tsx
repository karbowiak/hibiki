import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act, useState } from "react"
import { create } from "zustand"
const dom = new JSDOM(
  "<button id='launcher'>Edit</button><div id='root'></div>",
  { url: "https://synthetic.test" }
)
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const providerStore = create(() => ({ provider: null as any }))
const selections: any[] = [],
  invalidations: any[] = []
let libraryWrites = 0,
  saved = 0,
  closed = 0,
  edits: any[] = [],
  pending: { resolve: () => void; reject: (error: unknown) => void }[] = []
mock.module("../../src/stores/providerStore", () => ({
  useProviderStore: providerStore,
}))
mock.module("../../src/stores/libraryStore", () => ({
  useLibraryStore: {
    getState: () => ({
      invalidateLibraryTTLs: () => {
        libraryWrites++
      },
      playlists: [],
      currentPlaylist: null,
    }),
    setState: () => {
      libraryWrites++
    },
  },
}))
mock.module("../../src/stores/metadataCache", () => ({
  invalidateMetadataItem: (...args: any[]) => invalidations.push(args),
}))
mock.module("../../src/hooks/useMetadataSnapshot", () => ({
  useMetadataSnapshot: () => ({
    results: { apple: { status: "ready" } },
    requestedSources: ["apple"],
    isLoading: false,
    refresh: () => true,
    resolveField: () => ({
      value: '<img src=x onerror="alert(1)">',
      source: "apple",
      match: { kind: "exact-name" },
    }),
  }),
}))
mock.module("../../src/metadata/core/existingProviders", () => ({
  existingMetadataProviders: () => [
    {
      id: "apple",
      fields: { artist: ["biography", "genres"], album: ["summary"] },
    },
    ...["lastfm", "fanart", "heya"].map((id) => ({
      id,
      fields: { artist: ["biography"] },
    })),
  ],
}))
mock.module("../../src/stores/metadataSourceStore", () => ({
  SOURCE_LABELS: {
    apple: "Apple",
    plex: "Plex",
    lastfm: "Last.fm",
    fanart: "Fanart.tv",
    heya: "HeyaMetadata",
  },
}))
const selectionStore = create(() => ({
  choices: {},
  setChoice: (...args: any[]) => {
    selections.push(args)
    return true
  },
}))
mock.module("../../src/stores/metadataSelectionStore", () => ({
  useMetadataSelectionStore: selectionStore,
  metadataSelectionFor: () => undefined,
}))
mock.module("../../src/components/shared/ArtworkSourcePicker", () => ({
  ArtworkSourcePanel: () => <div>Artwork choices</div>,
}))
const { MetadataEditDialog } =
  await import("../../src/components/shared/MetadataEditDialog")
const { AppDialog } = await import("../../src/components/shared/AppDialog")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const item: any = {
  id: "1",
  title: "Artist",
  summary: "Original",
  thumbUrl: null,
}
function provider() {
  return {
    cacheScope: "account-a",
    playbackSession: "session-a",
    capabilities: { metadataEdit: true, playlistEdit: true },
    getArtist: async () => ({ ...item, title: "Reloaded" }),
    editMetadata: (...args: any[]) => {
      edits.push(args)
      return new Promise<void>((resolve, reject) =>
        pending.push({ resolve, reject })
      )
    },
  }
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
let serial = 0
function Harness({ nested = false }: { nested?: boolean }) {
  const [open, setOpen] = useState(true)
  const dialog = open ? (
    <MetadataEditDialog
      kind="artist"
      item={item}
      onClose={() => {
        closed++
        setOpen(false)
      }}
      onSaved={() => {
        saved++
      }}
    />
  ) : null
  return nested ? (
    <AppDialog title="Parent" onClose={() => {}}>
      {dialog}
    </AppDialog>
  ) : (
    dialog
  )
}
async function mount(nested = false) {
  await act(async () => {
    root.render(null)
    await flush()
    providerStore.setState({ provider: provider() })
    root.render(<Harness key={++serial} nested={nested} />)
    await flush()
  })
}
function button(text: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (x) => x.textContent?.trim() === text
  )
  assert.ok(node, `Missing button ${text}`)
  return node
}
async function click(text: string) {
  await act(async () => {
    button(text).click()
    await flush()
  })
}
async function title(value: string) {
  await act(async () => {
    const input = document.querySelector("input")!
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value"
    )!.set!
    setter.call(input, value)
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    await flush()
  })
}
async function review(value = "Changed") {
  await title(value)
  await click("Review changes")
  assert.ok(document.querySelector('[aria-label="Changes to save"]'))
}
await mount()
assert.equal(edits.length, 0)
await title("Changed")
assert.equal(edits.length, 0)
await review()
assert.equal(edits.length, 0, "Preview must not dispatch a write")
assert.equal(
  document.querySelector("input"),
  null,
  "Dedicated review must present comparisons instead of editable fields"
)
await click("Back to editing")
assert.equal(document.querySelector('[aria-label="Changes to save"]'), null)
await title("Changed")
assert.equal(edits.length, 0)
await click("Review changes")

await click("Save to Plex")
assert.equal(edits.length, 1)
assert.deepEqual(edits[0], [
  "artist",
  "1",
  { title: "Changed" },
  { title: "Artist" },
])
assert.equal(
  document.querySelector<HTMLButtonElement>('[aria-label="Close Edit artist"]')!
    .disabled,
  true
)
await act(async () => {
  document
    .querySelector("dialog")!
    .dispatchEvent(
      new dom.window.Event("cancel", { bubbles: true, cancelable: true })
    )
  await flush()
})
assert.equal(closed, 0, "Accepted write must retain dialog on Escape/cancel")
await act(async () => {
  pending.at(-1)!.resolve()
  await flush()
})
assert.equal(saved, 1)
assert.equal(libraryWrites, 1)
assert.deepEqual(invalidations, [["artist", "1"]])
for (const error of [
  "Plex metadata changed",
  "Save outcome unknown",
  "Plex did not confirm the save. Check server permissions and reload the item before retrying.",
  "https://private.example/?token=secret",
]) {
  await mount()
  await review()
  await click("Save to Plex")
  await act(async () => {
    pending.at(-1)!.reject(new Error(error))
    await flush()
  })
  assert.equal(button("Save to Plex").disabled, true)
  assert.ok(!document.body.textContent!.includes("token=secret"))
  await click("Reload current values")
  assert.equal(
    document.querySelector<HTMLInputElement>("input")!.value,
    "Reloaded"
  )
  await title("After reload")
  await click("Review changes")
  assert.equal(button("Save to Plex").disabled, false)
}
for (const change of ["provider", "scope", "session"]) {
  await mount()
  await review()
  const before = edits.length
  await act(async () => {
    const current = providerStore.getState().provider
    if (change === "provider") providerStore.setState({ provider: provider() })
    else {
      current[change === "scope" ? "cacheScope" : "playbackSession"] = "changed"
      providerStore.setState({ provider: current })
    }
    await flush()
  })
  assert.equal(document.querySelector("dialog"), null)
  assert.equal(edits.length, before)
  await mount()
  await review()
  await click("Save to Plex")
  const count = [saved, libraryWrites, invalidations.length]
  await act(async () => {
    const current = providerStore.getState().provider
    if (change === "provider") providerStore.setState({ provider: provider() })
    else {
      current[change === "scope" ? "cacheScope" : "playbackSession"] = "changed"
      providerStore.setState({ provider: current })
    }
    pending.at(-1)!.resolve()
    await flush()
  })
  assert.deepEqual(
    [saved, libraryWrites, invalidations.length],
    count,
    "Late result must not mutate replacement account UI"
  )
}
await mount()
await act(async () => {
  const general = button("General")
  general.focus()
  general.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    })
  )
  await flush()
})
assert.equal(
  button("Identity").getAttribute("aria-selected"),
  "true",
  "Child tab keyboard handler must run through dialog containment"
)
assert.equal(document.activeElement, button("Identity"))
await click("Metadata sources")
assert.equal(
  document.querySelector("img"),
  null,
  "External HTML must render as text"
)
assert.ok(document.body.textContent!.includes('<img src=x onerror="alert(1)">'))
await act(async () => {
  const select = document.querySelector<HTMLSelectElement>(
    '[aria-label="Biography source"]'
  )!
  select.value = "apple"
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
  await flush()
})
assert.equal(selections.length, 1)
assert.equal(selections[0][2], "biography")
assert.equal(selections[0][1], "apple")
await mount()
await review()
const admissions = edits.length
await act(async () => {
  button("Save to Plex").click()
  button("Save to Plex").click()
  await flush()
})
assert.equal(
  edits.length,
  admissions + 1,
  "Repeated clicks must admit only one write"
)
await act(async () => {
  pending.at(-1)!.resolve()
  await flush()
})
await mount()
let readCount = 0
let finishRead!: (value: any) => void
providerStore.getState().provider.getArtist = () => {
  readCount++
  return new Promise((resolve) => {
    finishRead = resolve
  })
}
await act(async () => {
  button("Reload current values").click()
  button("Reload current values").click()
  await flush()
})
assert.equal(readCount, 1, "Repeated reload must admit one request")
const closeRead = document.querySelector<HTMLButtonElement>(
  '[aria-label="Close Edit artist"]'
)!
assert.equal(
  closeRead.disabled,
  false,
  "Read-only reload may be retired by closing"
)
await act(async () => {
  closeRead.click()
  await flush()
})
assert.equal(document.querySelector("dialog"), null)
await act(async () => {
  finishRead({ ...item, title: "Late reload" })
  await flush()
})
assert.equal(document.querySelector("dialog"), null)
await mount(true)
let globalShortcut = 0
const hotkey = () => {
  globalShortcut++
}
window.addEventListener("keydown", hotkey)
const input = document.querySelector("input")!
for (const key of ["k", "f", "r"])
  input.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
  )
assert.equal(
  globalShortcut,
  0,
  "Nested dialog shortcuts must not reach app search/refresh"
)
window.removeEventListener("keydown", hotkey)
await mount()
const { useFanartServiceStore, useHeyaServiceStore } =
  await import("../../src/metadata/services/store")
const { useLastfmStore } = await import("../../src/metadata/lastfm/authStore")
await click("Metadata sources")
const hasOption = (source: string) =>
  !!document.querySelector(`option[value="${source}"]`)
for (const source of ["lastfm", "fanart", "heya"])
  assert.equal(hasOption(source), false, `${source} is not configured`)
assert.equal(hasOption("apple"), true, "Public sources stay available")
const serviceStatus = {
  revision: "synthetic-source-1",
  baseUrl: "https://synthetic.test",
  configured: true,
  enabled: true,
  hasApiKey: false,
}
await act(async () => {
  useFanartServiceStore.setState({ status: serviceStatus })
  useHeyaServiceStore.setState({ status: serviceStatus })
  useLastfmStore.setState({ hasApiKey: true })
  await flush()
})
for (const source of ["lastfm", "fanart", "heya"])
  assert.equal(
    hasOption(source),
    true,
    `${source} is available after configuration`
  )
await act(async () => {
  useFanartServiceStore.setState({
    status: {
      ...serviceStatus,
      enabled: false,
      revision: "synthetic-source-2",
    },
  })
  useHeyaServiceStore.setState({
    status: {
      ...serviceStatus,
      configured: false,
      revision: "synthetic-source-2",
    },
  })
  useLastfmStore.setState({ hasApiKey: false })
  await flush()
})
for (const source of ["lastfm", "fanart", "heya"])
  assert.equal(
    hasOption(source),
    false,
    `${source} disappears when unavailable`
  )
await act(async () => root.unmount())
assert.equal(document.getElementById("root")!.hasAttribute("inert"), false)
