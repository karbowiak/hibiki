import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { create } from "zustand"
import { act } from "react"
import { deferred } from "../helpers/radioAudioFakes"
import type {
  PlaylistAdapter,
  PlaylistAttempt,
  PlaylistSnapshot,
} from "../../src/playlistSync/types"
const dom = new JSDOM(
  "<button id='opener'>Open copies</button><div id='root'></div>",
  { url: "https://hibiki.test/playlists" }
)
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const auth = create(() => ({ username: "listener", isAuthenticated: true }))
mock.module("../../src/metadata/listenbrainz/authStore", () => ({
  useListenBrainzStore: auth,
}))
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }))
const { createRoot } = await import("react-dom/client")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { PlaylistCopyDialog } =
  await import("../../src/components/PlaylistSync/PlaylistCopyDialog")
const { PlaylistCopyReceipts } =
  await import("../../src/components/PlaylistSync/PlaylistCopyReceipts")
const root = createRoot(document.getElementById("root")!)
const scenario = process.argv[2]!,
  A = "12345678-1234-1234-1234-123456789abc",
  B = "22345678-1234-1234-1234-123456789abc",
  ID = "32345678-1234-1234-1234-123456789abc"
const local = {
    service: "library:Test",
    user: "opaque-library",
    revision: "scope-v1",
  },
  remote = { service: "listenbrainz", user: "listener", revision: "1" }
const songs = ["a", "b", "a"].map((id, index) => ({
  occurrenceId: String(index),
  track: {
    id,
    title: id === "a" ? "Song A" : "Song B",
    artist: "Artist",
    album: "Album",
    recordingMbid: index === 1 ? B : A,
  },
}))
const source: PlaylistSnapshot = {
  account: remote,
  id: ID,
  title: "Source playlist",
  items: songs,
}
let writes = 0,
  searches = 0,
  reads = 0,
  sent: readonly string[] = [],
  saved: PlaylistAttempt[] = [],
  failRetention = scenario === "retention" || scenario === "dismissal-retention"
const pendingSearch = deferred<any[]>(),
  pendingCreate = deferred<{ id: string }>()
const provider: any = {
  name: "Test",
  cacheScope: "opaque-library",
  playbackSession: {},
  capabilities: { playlists: true, search: true },
  getPlaylists: async () => [{ id: "created", title: source.title }],
  search: async () => {
    searches++
    if (scenario === "retired") return pendingSearch.promise
    return ["a", "b"].map((id) => ({
      type: "track",
      id,
      title: id === "a" ? "Song A" : "Song B",
      artistName: "Artist",
      albumName: "Album",
      duration: 1000,
    }))
  },
}
useProviderStore.getState().setProvider(provider)
const capabilities = { read: true, createCopy: true, replace: false }
const library: PlaylistAdapter = {
  capabilities: {
    ...capabilities,
    ...(scenario === "duplicate-blocked"
      ? { preservesDuplicateCopies: false }
      : {}),
  },
  account: async () => local,
  read: async (id) => ({
    account: local,
    id,
    title: source.title,
    items: songs.map((item) => ({
      ...item,
      track: { ...item.track, recordingMbid: null },
    })),
  }),
  createCopy: async (_title, tracks) => {
    writes++
    sent = tracks.map((track) => track.id)
    return { id: "created" }
  },
}
const lb: any = {
  capabilities,
  account: async () => remote,
  list: async () => ({ items: [{ ...source, items: [] }], total: 1 }),
  read: async (id: string) => {
    reads++
    return { ...source, id }
  },
  createCopy: async (_title, tracks) => {
    writes++
    sent = tracks.map((track) => track.recordingMbid)
    return scenario === "retention" || scenario === "retired-create"
      ? pendingCreate.promise
      : { id: ID }
  },
}
const services: any = {
  account: async () => remote,
  listenBrainz: () => lb,
  library: () => library,
  journal: {
    list: async () => saved,
    save: async (attempt: PlaylistAttempt) => {
      if (failRetention && attempt.state !== "admitting")
        throw Error("private-indexeddb-error")
      saved.push(structuredClone(attempt))
    },
  },
}
let closed = 0,
  refreshed = 0
async function flush() {
  await act(async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve()
  })
}
async function render(mode: "import" | "export" = "import") {
  await act(async () =>
    root.render(
      <PlaylistCopyDialog
        mode={mode}
        playlistId={mode === "export" ? "source" : undefined}
        services={services}
        onClose={() => {
          closed++
        }}
        onCreated={() => {
          refreshed++
        }}
      />
    )
  )
  await flush()
}
function buttons() {
  return [...document.querySelectorAll<HTMLButtonElement>("dialog button")]
}
function button(label: string) {
  const found = buttons().find(
    (item) =>
      item.textContent === label || item.getAttribute("aria-label") === label
  )
  assert.ok(found, `Missing ${label}`)
  return found!
}
async function click(label: string) {
  await act(async () => button(label).click())
  await flush()
}
async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value"
    )!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
  })
  await flush()
}
async function exportRows() {
  await render("export")
  assert.equal(button("Export this private copy").disabled, true)
  const fields = [
    ...document.querySelectorAll<HTMLInputElement>("input"),
  ].filter((item) => item.placeholder.includes("xxxxxxxx"))
  assert.equal(fields.length, 3)
  for (let index = 0; index < 3; index++) {
    await change(fields[index], index === 1 ? B : A)
    const article = fields[index].closest("article")!
    const link = [...article.querySelectorAll("a")].find(
      (item) => item.textContent === "Verify artist and title on MusicBrainz"
    )
    assert.ok(link)
    assert.equal(
      link.getAttribute("href"),
      `https://musicbrainz.org/recording/${index === 1 ? B : A}`
    )
    await act(async () =>
      article.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    )
    await click(`Use verified recording for occurrence ${index + 1}`)
    if (index < 2)
      assert.equal(
        button("Export this private copy").disabled,
        true,
        "one occurrence must not resolve its duplicate"
      )
  }
  assert.equal(button("Export this private copy").disabled, false)
}
document.getElementById("opener")!.focus()
if (scenario === "duplicate-blocked") {
  await render()
  await click("Source playlist")
  assert.equal(document.querySelectorAll("ol > li").length, 3)
  assert.equal(button("Import this copy").disabled, true)
  assert.ok(
    document.body.textContent!.includes("Plex cannot preserve repeated songs")
  )
  await click("Import this copy")
  assert.equal(writes, 0)
  assert.equal(saved.length, 0)
} else if (scenario === "import") {
  await render()
  assert.ok(document.body.textContent!.includes("Last.fm does not support"))
  const choice = button("Source playlist")
  await act(async () => {
    choice.click()
    choice.click()
  })
  await flush()
  assert.equal(
    reads,
    1,
    "same-frame duplicate selections must not repeat source reads"
  )
  assert.equal(searches, 2, "only unique recording queries are searched")
  assert.equal(document.querySelectorAll("ol > li").length, 3)
  assert.equal(button("Import this copy").disabled, false)
  await act(async () => {
    button("Import this copy").click()
    button("Import this copy").click()
  })
  await flush()
  assert.equal(writes, 1)
  assert.deepEqual(sent, ["a", "b", "a"])
  assert.equal(saved[0].state, "admitting")
  assert.equal(saved.at(-1)!.state, "verified")
  assert.ok(
    document.body.textContent!.includes(
      "Copy created and its ordered songs verified"
    )
  )
  assert.equal(refreshed, 1)
  assert.equal(document.body.textContent!.includes("opaque-library"), false)
} else if (scenario === "export") {
  await exportRows()
  await click("Export this private copy")
  assert.equal(writes, 1)
  assert.deepEqual(sent, [A, B, A])
  assert.equal(saved.at(-1)!.state, "verified")
} else if (scenario === "retired") {
  await render()
  await act(async () => button("Source playlist").click())
  await flush()
  await act(async () =>
    useProviderStore
      .getState()
      .setProvider({ ...provider, cacheScope: "replacement" })
  )
  await flush()
  await act(async () => pendingSearch.resolve([]))
  await flush()
  assert.equal(document.querySelectorAll("ol > li").length, 0)
  assert.equal(writes, 0)
  assert.equal(refreshed, 0)
} else if (scenario === "retired-create") {
  await exportRows()
  await act(async () => button("Export this private copy").click())
  await flush()
  await act(async () =>
    useProviderStore
      .getState()
      .setProvider({ ...provider, cacheScope: "replacement" })
  )
  await flush()
  await act(async () => pendingCreate.resolve({ id: ID }))
  await flush()
  assert.equal(writes, 1)
  assert.equal(saved.at(-1)!.state, "created")
  assert.equal(refreshed, 0)
  assert.equal(button("Close Export a private playlist copy").disabled, false)
  assert.equal(
    document.body.textContent!.includes(
      "Copy created and its ordered songs verified"
    ),
    false
  )
} else if (scenario === "retention") {
  await exportRows()
  await act(async () => button("Export this private copy").click())
  await flush()
  assert.equal(button("Close Export a private playlist copy").disabled, true)
  await act(async () => pendingCreate.resolve({ id: ID }))
  await flush()
  assert.equal(writes, 1)
  assert.equal(saved[0].state, "admitting")
  assert.equal(button("Close Export a private playlist copy").disabled, true)
  assert.equal(
    document.body.textContent!.includes("private-indexeddb-error"),
    false
  )
  assert.ok(button("Retry saving receipt"))
  failRetention = false
  await click("Retry saving receipt")
  assert.equal(saved.at(-1)!.destinationId, ID)
  assert.equal(writes, 1)
  assert.equal(button("Close Export a private playlist copy").disabled, false)
} else {
  saved = [
    {
      id: "attempt",
      account: remote,
      sourceAccount: local,
      sourcePlaylistId: "source",
      title: source.title,
      expectedTrackIds: [A, B, A],
      createdAt: 0,
      state: "reconcile",
    },
  ]
  await act(async () =>
    root.render(
      <PlaylistCopyReceipts
        services={services}
        onClose={() => {
          closed++
        }}
      />
    )
  )
  await flush()
  if (scenario.startsWith("dismissal")) {
    assert.equal(button("Dismiss this local blocker").disabled, true)
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click()
    )
    await click("Dismiss this local blocker")
    if (scenario === "dismissal-retention") {
      assert.equal(saved.length, 1)
      assert.equal(saved[0].state, "reconcile")
      assert.equal(
        document.body.textContent!.includes("private-indexeddb-error"),
        false
      )
      assert.ok(button("Retry local dismissal"))
      failRetention = false
      await click("Retry local dismissal")
    }

    assert.equal(saved.at(-1)!.state, "dismissed")
    assert.equal(saved.at(-1)!.dismissalReason, "manual-unknown-outcome")
    assert.ok(saved.at(-1)!.dismissedAt)
    assert.equal(writes, 0)
    assert.ok(
      document.body.textContent!.includes("remote outcome was not confirmed")
    )
  } else {
    await click("Browse destination playlists")
    await click("Source playlist")
    await click("Verify this copy")
    assert.equal(saved.at(-1)!.state, "verified")
    assert.equal(writes, 0)
    assert.ok(document.body.textContent!.includes("Ordered songs verified"))
  }
}
await act(async () => root.unmount())
assert.equal(document.getElementById("root")!.hasAttribute("inert"), false)
assert.equal(document.activeElement, document.getElementById("opener"))
dom.window.close()
