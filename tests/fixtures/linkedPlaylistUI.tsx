import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { deferred, settle } from "../helpers/radioAudioFakes"
const dom = new JSDOM(
  "<button id='outside'>Outside</button><div id='root'></div>",
  { url: "https://synthetic.test" }
)
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { createRoot } = await import("react-dom/client")
const { LinkedPlaylistManager } =
  await import("../../src/components/PlaylistSync/LinkedPlaylistManager")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useListenBrainzStore } =
  await import("../../src/metadata/listenbrainz/authStore")
const { retainLink } = await import("../../src/playlistSync/linkedJournal")
const { applySequenceOperation } = await import("../../src/playlistSync/linked")
await settle()
const A = "11111111-1111-4111-8111-111111111111",
  remoteId = "22222222-2222-4222-8222-222222222222"
const account = (service: string) => ({
  service,
  user: service === "listenbrainz" ? "owner" : "scope",
  revision: "lease",
})
let local: any = {
    account: account("library:Plex"),
    id: "1",
    title: "Local",
    items: [
      {
        occurrenceId: "11",
        track: {
          id: "1",
          title: "Song",
          artist: "Artist",
          recordingMbid: null,
        },
      },
    ],
  },
  remote: any = {
    account: account("listenbrainz"),
    id: remoteId,
    title: "Remote",
    items: [],
  },
  rows: any[] = [],
  saveCalls = 0,
  mutations = 0
const saveGate = deferred<void>()
const repo = {
  load: async () => structuredClone(rows),
  save: async (link: any, revision: number | null) => {
    saveCalls++
    if (saveCalls === 1) await saveGate.promise
    rows = retainLink(rows, link, revision)
    return structuredClone(rows[0])
  },
}
const provider: any = {
  name: "Plex",
  cacheScope: "scope",
  capabilities: { playlists: true, playlistEdit: true, search: true },
  playbackSession: {},
  mutatePlaylistOccurrence: async () => {},
  getPlaylists: async () => [{ id: "1", title: "Local", smart: false }],
  search: async () => [],
}
useProviderStore.setState({ provider })
useListenBrainzStore.setState({ isAuthenticated: true, username: "owner" })
const library = {
  capabilities: { read: true, createCopy: true, replace: false },
  account: async () => account("library:Plex"),
  read: async () => structuredClone(local),
  createCopy: async () => ({ id: "unused" }),
}
const remoteAdapter = {
  ...library,
  account: async () => account("listenbrainz"),
  read: async () => structuredClone(remote),
  list: async () => ({ items: [structuredClone(remote)], total: 1 }),
}
const services: any = {
  account: async () => account("listenbrainz"),
  library: () => library,
  remote: () => remoteAdapter,
  repository: repo,
  sync: async (_provider: any, _link: any, current: () => boolean) => ({
    repository: repo,
    current,
    library: {
      ...library,
      mutate: async () => {
        throw Error("Not needed")
      },
    },
    listenbrainz: {
      ...remoteAdapter,
      mutate: async (before: any, operation: any) => {
        mutations++
        const ids = applySequenceOperation(
          before.items.map((item: any) => item.track.id),
          operation
        )
        remote = {
          ...remote,
          items: ids.map((id, index) => ({
            occurrenceId: `${remoteId}:${index}`,
            track: { id, recordingMbid: id, title: "Song", artist: "Artist" },
          })),
        }
        return structuredClone(remote)
      },
    },
  }),
}
const root = createRoot(document.getElementById("root")!)
let closed = 0
await act(async () => {
  root.render(
    <LinkedPlaylistManager
      playlistId="1"
      services={services}
      onClose={() => closed++}
    />
  )
  await settle()
})
const button = (label: string) => {
  const found = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label
  )
  assert.ok(found, `Missing ${label}`)
  return found!
}
const input = (label: string) => {
  const found = [...document.querySelectorAll("label")]
    .find((element) => element.textContent?.includes(label))
    ?.querySelector("input")
  assert.ok(found, `Missing ${label}`)
  return found!
}
async function click(label: string) {
  await act(async () => {
    button(label).click()
    await settle()
  })
}
async function select(label: string, value: string) {
  const element = [...document.querySelectorAll("label")]
    .find((element) => element.textContent?.includes(label))
    ?.querySelector("select")
  assert.ok(element)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLSelectElement.prototype,
      "value"
    )!.set!
    setter.call(element, value)
    element!.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
    await settle()
  })
}
await select("ListenBrainz playlist", remoteId)
await click("Preview link")
assert.equal(mutations, 0)
const mbid = input("Recording MBID for occurrence 1")
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value"
  )!.set!
  setter.call(mbid, A)
  mbid.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  mbid.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
  await settle()
})
await act(async () => {
  input("I checked this recording’s artist and title.").click()
  await settle()
})
await click("Use verified recording for occurrence 1")
assert.equal((button("Enable linked sync") as HTMLButtonElement).disabled, true)
await act(async () => input("I reviewed the ordered songs").click())
await act(async () => {
  button("Enable linked sync").click()
  button("Enable linked sync").click()
  await settle()
})
assert.equal(saveCalls, 1)
assert.equal(mutations, 0)
const close = document.querySelector(
  'button[aria-label="Close dialog"]'
) as HTMLButtonElement | null
if (close) assert.equal(close.disabled, true)
await act(async () => {
  saveGate.resolve()
  await settle()
})
assert.equal(rows.length, 1)
assert.equal(rows[0].enabled, true)
assert.equal(rows[0].job.desired[0].id, A)
await click("Check now")
assert.equal(mutations, 1)
assert.equal(rows[0].job, undefined)
assert.equal(rows[0].history[0].state, "verified")
await click("Pause")
assert.equal(rows[0].paused, true)
assert.equal(mutations, 1)
await act(() => root.unmount())
dom.window.close()
