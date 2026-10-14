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
const smart = process.argv[2]?.includes("smart") ?? false
const newRemote = process.argv[2]?.startsWith("new") ?? false
let creates = 0,
  intents: any[] = []
const { retainSyncCreation } = await import("../../src/playlistSync/creation")
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
    ...(smart ? { readOnly: true } : {}),
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
  getPlaylists: async () => [{ id: "1", title: "Local", smart }],
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
  list: async () => ({
    items: newRemote ? [] : [structuredClone(remote)],
    total: newRemote ? 0 : 1,
  }),
  createCopy: async (title: string, tracks: any[]) => {
    creates++
    assert.equal(tracks.length, 0)
    remote = { ...remote, title }
    return { id: remoteId }
  },
}
const services: any = {
  creationJournal: {
    load: async () => structuredClone(intents),
    save: async (intent: any) => {
      intents = retainSyncCreation(intents, intent)
    },
  },
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
if (smart) {
  const direction = [...document.querySelectorAll("label")]
    .find((label) => label.textContent?.startsWith("Sync direction"))!
    .querySelector("select")!
  assert.equal(direction.value, "export")
  assert.equal(
    direction.querySelector<HTMLOptionElement>('option[value="import"]')!
      .disabled,
    true
  )
  assert.equal(
    direction.querySelector<HTMLOptionElement>('option[value="bidirectional"]')!
      .disabled,
    true
  )
  assert.ok(
    document.body.textContent!.includes(
      "Smart playlists are read-only snapshots"
    )
  )
}
if (newRemote) {
  assert.equal(input("New ListenBrainz playlist name").value, "Local")
  assert.equal(button("Create ListenBrainz playlist").disabled, false)
  saveGate.resolve()
  await click("Create ListenBrainz playlist")
  assert.equal(creates, 1)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].paused, true)
  assert.equal(rows[0].direction, "export")
  assert.equal(rows[0].incomplete, undefined)
  assert.deepEqual(intents[0].sourceSnapshot.items, local.items)
  assert.ok(document.body.textContent!.includes("Review 1 ordered occurrences"))
} else {
  await select("ListenBrainz playlist", remoteId)
  await click("Preview link")
}
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
assert.equal((button("Save reviewed link") as HTMLButtonElement).disabled, true)
await act(async () => input("I reviewed every ordered song").click())
await act(async () => {
  button("Save reviewed link").click()
  button("Save reviewed link").click()
  await settle()
})
assert.equal(saveCalls, newRemote ? 2 : 1)
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
assert.equal(rows[0].direction, "export")
assert.equal(rows[0].automatic, false)
assert.equal(rows[0].job.desired[0].id, A)
await click("Sync now")
assert.equal(mutations, 1)
assert.equal(rows[0].job, undefined)
assert.equal(rows[0].history[0].state, "verified")
await click("Pause")
assert.equal(rows[0].paused, true)
assert.equal(
  rows[0].pauseReason,
  "manual",
  "Explicit pause cannot inherit unmatched rollover permission"
)
assert.equal(mutations, 1)
if (smart || newRemote) {
  assert.equal(rows[0].baseline.library.readOnly, smart ? true : undefined)
  assert.equal(rows[0].direction, "export")
  assert.equal(
    mutations,
    1,
    "Only synthetic remote update is admitted for smart export"
  )
  await act(() => root.unmount())
  dom.window.close()
  process.exit(0)
}
// A completed background import keeps unresolved source rows until explicit review.
rows = [
  {
    ...rows[0],
    direction: "import",
    automatic: false,
    mappings: [
      ...rows[0].mappings,
      {
        libraryTrack: { ...local.items[0].track, id: "obsolete" },
        recordingMbid: A,
        verifiedBy: "reviewed",
        sourceOccurrenceId: remote.items[0].occurrenceId,
      },
    ],
    incomplete: {
      sourceSnapshot: structuredClone(remote),
      missingOccurrenceIds: [remote.items[0].occurrenceId],
      matchedCount: 0,
      total: 1,
      matchingCursor: 1,
      matchingDone: true,
    },
  },
]
await act(async () => {
  root.render(
    <LinkedPlaylistManager
      key="import-review"
      playlistId="1"
      initialTab="review"
      services={services}
      onClose={() => closed++}
    />
  )
  await settle()
})
assert.ok(document.body.textContent!.includes("Background matching is paused"))
await click("Review versions and resume")
assert.ok(
  document.body.textContent!.includes("ListenBrainz version"),
  "Existing import must review the remote source despite local default export"
)
await click("Confirm local match occurrence 1")
await act(async () => {
  input("I reviewed every ordered song").click()
  await settle()
})
await click("Save reviewed link")
assert.equal(
  rows[0].incomplete,
  undefined,
  "Fully reviewed source retires retained incomplete progress"
)
assert.equal(rows[0].direction, "import")
assert.equal(
  rows[0].pauseReason,
  undefined,
  "Explicit reviewed resume clears manual pause"
)
assert.ok(
  rows[0].mappings.some(
    (mapping: any) =>
      mapping.sourceOccurrenceId === remote.items[0].occurrenceId
  ),
  "Per-occurrence reviewed choice is retained"
)
assert.equal(mutations, 1, "Review retention itself does not write remotely")
assert.equal(
  rows[0].mappings.some(
    (mapping: any) => mapping.libraryTrack.id === "obsolete"
  ),
  false,
  "New per-occurrence choice replaces obsolete reviewed mapping"
)
// Persisted metadata IDs are lookup keys, not new recording-ID proof.
local.items[0].track.recordingMbid = A
rows = [
  {
    ...rows[0],
    paused: false,
    mappings: [
      {
        libraryTrack: structuredClone(local.items[0].track),
        recordingMbid: A,
        verifiedBy: "metadata",
      },
    ],
  },
]
await act(async () => {
  root.render(
    <LinkedPlaylistManager
      key="evidence"
      playlistId="1"
      initialTab="review"
      services={services}
      onClose={() => closed++}
    />
  )
  await settle()
})
await click("Review versions and resume")
assert.ok(document.body.textContent!.includes("Matched by metadata"))
assert.equal(
  document.body.textContent!.includes("Matched by recording ID"),
  false,
  "Saved fuzzy mapping must not upgrade to recording-ID evidence"
)
assert.equal(document.body.textContent!.includes("compare-and-swap"), false)
assert.equal(
  document.body.textContent!.includes("Last.fm playlist syncing"),
  false
)
// Retry re-admits lookups only; uncertain write receipts keep the recovery path.
const { useLinkedPlaylistStore } =
  await import("../../src/stores/linkedPlaylistStore")
const retryGate = deferred<void>()
let retries = 0
useLinkedPlaylistStore.setState({
  retryMatching: async (_id: string, current?: () => boolean) => {
    assert.equal(current?.(), true)
    retries++
    await retryGate.promise
  },
})
rows = [
  {
    ...rows[0],
    state: "error",
    paused: true,
    incomplete: {
      sourceSnapshot: structuredClone(remote),
      missingOccurrenceIds: [remote.items[0].occurrenceId],
      matchedCount: 0,
      total: 1,
      matchingCursor: 0,
      matchingDone: false,
      lookupLimits: [
        { sourceTrackId: remote.items[0].track.id, reason: "unavailable" },
      ],
    },
  },
]
await act(async () => {
  root.render(
    <LinkedPlaylistManager
      key="retry"
      playlistId="1"
      initialTab="review"
      services={services}
      onClose={() => closed++}
    />
  )
  await settle()
})
assert.ok(
  document.body.textContent!.includes(
    "does not mean they are missing from your library"
  )
)
await act(async () => {
  button("Retry background lookups").click()
  button("Retry background lookups").click()
  await settle()
})
assert.equal(retries, 1, "Concurrent retry has one admission")
assert.equal(mutations, 1, "Lookup retry itself does not mutate playlists")
await act(async () => {
  retryGate.resolve()
  await settle()
})
// Legacy completed partial imports offer an explicit rematch, not generic conflict retry.
rows = [
  {
    ...rows[0],
    state: "conflict",
    paused: true,
    pauseReason: undefined,
    job: undefined,
    message:
      "0 of 1 songs matched. Review unmatched songs; every original occurrence is retained.",
    incomplete: {
      ...rows[0].incomplete,
      matchingDone: true,
      matchingCursor: 1,
    },
  },
]
await act(async () => {
  root.render(
    <LinkedPlaylistManager
      key="rematch"
      playlistId="1"
      initialTab="review"
      services={services}
      onClose={() => closed++}
    />
  )
  await settle()
})
await click("Find more matches")
assert.equal(
  retries,
  2,
  "Explicit completed-partial rematch uses guarded domain retry"
)
for (const change of [
  { pauseReason: "manual" },
  { message: "The source changed; review the conflict" },
]) {
  const original = rows[0]
  rows = [{ ...original, ...change }]
  await act(async () => {
    root.render(
      <LinkedPlaylistManager
        key={JSON.stringify(change)}
        playlistId="1"
        initialTab="review"
        services={services}
        onClose={() => closed++}
      />
    )
    await settle()
  })
  assert.equal(
    [...document.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Find more matches")
    ),
    false,
    "Manual pause and source conflicts must not expose automatic rematch"
  )
  rows = [original]
}
for (const field of ["step", "descriptionStep"]) {
  rows = [
    {
      ...rows[0],
      job: {
        id: "unknown",
        source: "listenbrainz",
        sourceSnapshot: remote,
        destinationSnapshot: local,
        desired: [],
        completedSteps: 0,
        [field]: {
          id: "unknown",
          state: "unknown",
          before: local,
          description: "Expected description",
        },
      },
    },
  ]
  await act(async () => {
    root.render(
      <LinkedPlaylistManager
        key={field}
        playlistId="1"
        initialTab="review"
        services={services}
        onClose={() => closed++}
      />
    )
    await settle()
  })
  assert.equal(
    [...document.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Retry background lookups")
    ),
    false,
    "Uncertain write must be inspected instead of lookup retry"
  )
  assert.ok(button("Read recovery proof"))
}
await act(() => root.unmount())
dom.window.close()
