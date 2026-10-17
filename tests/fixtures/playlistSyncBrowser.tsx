import assert from "node:assert/strict"
import { mock } from "bun:test"
import { create } from "zustand"
import { JSDOM } from "jsdom"
import { act } from "react"
import { deferred, settle } from "../helpers/radioAudioFakes"
const dom = new JSDOM(
  '<button id="outside">Outside</button><div id="root"></div>',
  { url: "https://synthetic.test/playlists" }
)
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const auth = create(() => ({ isAuthenticated: true, username: "listener" }))
mock.module("../../src/metadata/listenbrainz/authStore", () => ({
  useListenBrainzStore: auth,
}))
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }))
const { createRoot } = await import("react-dom/client")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { SyncCreationError } = await import("../../src/playlistSync/creation")
const { PlaylistCopyDialog } =
  await import("../../src/components/PlaylistSync/PlaylistCopyDialog")
const { PlaylistSyncDialog } =
  await import("../../src/components/PlaylistSync/PlaylistSyncDialog")
const scenario = process.argv[2],
  account = { service: "listenbrainz", user: "listener", revision: "lease" },
  localAccount = {
    service: "library:Plex",
    user: "scope",
    revision: "scope-v1",
  }
const id = "11111111-1111-4111-8111-111111111111",
  mbid = "22222222-2222-4222-8222-222222222222"
const summary = (
  title: string,
  origin: "created" | "createdfor" | "collaborator",
  index: number
) => ({
  account,
  id: `${index}1111111-1111-4111-8111-111111111111`,
  title,
  items: [],
  access: {
    origins: [origin],
    creator: origin === "created" ? "listener" : "weekly-bot",
    owned: origin === "created",
    writable: origin === "created",
    generated: origin === "createdfor",
  },
})
let items: any[] = [
  summary("Owned playlist", "created", 1),
  summary("Weekly discovery", "createdfor", 2),
  summary("Shared playlist", "collaborator", 3),
]
if (scenario.startsWith("weekly")) {
  items = [
    summary("Owned playlist", "created", 1),
    ...[2, 3, 4, 5].map((index) => ({
      ...summary(`Dated generated ${index}`, "createdfor", index),
      access: {
        ...summary("", "createdfor", index).access,
        creator: "listenbrainz",
      },
      weekly: {
        family: index < 4 ? "weekly-exploration" : "weekly-jams",
        recipient: "listener",
        weekOf: scenario === "weekly-nodate" ? null : "2026-10-05",
        createdAt: `2026-10-05T05:${index % 2 === 0 ? "40" : "49"}:00.123456Z`,
      },
    })),
  ]
  if (scenario === "weekly-tie")
    items[2].weekly.createdAt = items[1].weekly.createdAt
}
let listings = 0,
  reads = 0,
  writes = 0,
  rows: any[] = [],
  searches: string[] = []
const createGate = deferred<any>()
const listingGate = deferred<any>(),
  replacementGate = deferred<any>()
const provider: any = {
  name: "Plex",
  cacheScope: "scope",
  playbackSession: {},
  capabilities: { playlists: true, search: true, playlistEdit: true },
  getPlaylists: async () => [
    { id: "local", title: "Existing local", smart: false },
  ],
  mutatePlaylistOccurrence: async () => {},
  search: async (query: string) => {
    searches.push(query)
    return scenario === "wildcard"
      ? [
          {
            type: "track",
            id: "live",
            title: "Song (Live)",
            artistName: "Artist",
            albumName: "Live album",
            duration: 200000,
          },
          {
            type: "track",
            id: "other",
            title: "Unrelated",
            artistName: "Else",
            albumName: "Album",
            duration: 200000,
          },
        ]
      : []
  },
}
useProviderStore.setState({ provider })
const snapshots = new Map(
  items.map((item) => [
    item.id,
    {
      ...item,
      items: [
        {
          occurrenceId: "1",
          track: {
            id: mbid,
            recordingMbid: mbid,
            title: "Song",
            artist: "Artist",
            durationMs: 200000,
          },
        },
      ],
    },
  ])
)
const remote = {
  capabilities: { read: true, createCopy: false, replace: false },
  account: async () => account,
  read: async (id: string) => {
    reads++
    return structuredClone(snapshots.get(id)!)
  },
  list: async () => {
    throw Error("Legacy created-only list must not be used")
  },
  createCopy: async () => {
    writes++
    throw Error("Not admitted")
  },
}
const library = {
  capabilities: { read: true, createCopy: true, replace: false },
  account: async () => localAccount,
  read: async () => ({
    account: localAccount,
    id: "local",
    title: "Existing local",
    items: [],
  }),
  createCopy: async () => {
    writes++
    return { id: "copy" }
  },
}
const copyServices: any = {
  account: async () => account,
  listenBrainz: () => remote,
  library: () => library,
  journal: {
    list: async () => [],
    retain: async () => {},
    update: async () => {},
  },
}
const linkServices: any = {
  account: async () => account,
  remote: () => remote,
  library: () => library,
  repository: {
    load: async () => rows,
    save: async (value: any) => {
      writes++
      rows = [value]
      return value
    },
  },
  sync: async () => {
    throw Error("No sync admitted")
  },
}
const services = {
  create: async (
    summary: any,
    title: string,
    current: () => boolean,
    edition?: any
  ) => {
    assert.equal(current(), true)
    writes++
    assert.equal(title, summary.title)
    const source = snapshots.get(summary.id)!
    if (scenario === "create-unknown")
      throw new SyncCreationError("private URL/token must not render", {
        id: "unknown",
        state: "reconcile",
        title,
        sourceSnapshot: source,
        target: localAccount,
      } as any)
    if (scenario === "create-pending" || scenario === "create-retired")
      return createGate.promise
    const intent: any = { id: "intent", state: "linked", destinationId: "copy" }
    return { intent, link: { libraryPlaylistId: "copy" } as any }
  },
  account: async () => account,
  list: async () => {
    listings++
    return scenario === "retired"
      ? listings === 1
        ? listingGate.promise
        : replacementGate.promise
      : {
          items,
          total: items.length,
          complete: scenario.startsWith("weekly"),
          truncated: !scenario.startsWith("weekly"),
        }
  },
}
const root = createRoot(document.getElementById("root")!)
await act(async () => {
  root.render(
    <PlaylistSyncDialog
      services={services}
      copyServices={copyServices}
      linkServices={linkServices}
      onClose={() => {}}
    />
  )
  await settle()
})
const button = (text: string) => {
  const b = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.includes(text)
  )
  assert.ok(b, `Missing button ${text}`)
  return b
}
async function click(text: string) {
  await act(async () => {
    button(text).click()
    await settle()
  })
}
async function select(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value
    element.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
    await settle()
  })
}
if (scenario === "retired") {
  await act(async () => {
    useProviderStore.setState({
      provider: { ...provider, cacheScope: "other" },
    })
    useProviderStore.setState({ provider })
    listingGate.resolve({ items, total: 3, complete: true, truncated: false })
    await settle()
  })
  assert.equal(
    document.body.textContent!.includes("Owned playlist"),
    false,
    "ABA-retired roster must not publish"
  )
} else {
  assert.equal(listings, 1)
  assert.equal(reads, 0)
  assert.equal(writes, 0)
  assert.equal(document.querySelectorAll("dialog").length, 1)
  if (!scenario.startsWith("weekly"))
    assert.ok(document.body.textContent!.includes("bounded partial listing"))
  assert.ok(document.body.textContent!.includes("Owned playlist"))
  if (scenario.startsWith("weekly")) {
    const cards = [
      ...document.querySelectorAll(
        'section[aria-label="Weekly recommendation channels"] button'
      ),
    ]
    assert.equal(cards.length, 2)
    assert.equal(
      cards[0].querySelector("span")!.textContent,
      "Weekly Exploration"
    )
    assert.equal(cards[1].querySelector("span")!.textContent, "Weekly Jams")
    assert.equal(
      document.body.textContent!.includes("Dated generated 2"),
      false
    )
    await click("Weekly Exploration")
    if (scenario === "weekly-tie") {
      assert.ok(
        document.querySelector('section[aria-label="Choose a weekly edition"]')
      )
      assert.equal(
        document.querySelector(
          'section[aria-label="Choose a Plex destination"]'
        ),
        null
      )
      const choice = document.querySelector<HTMLButtonElement>(
        'section[aria-label="Choose a weekly edition"] button'
      )!
      await act(async () => {
        choice.click()
        await settle()
      })
    }
    assert.equal(reads, 0)
    assert.ok(
      document.body.textContent!.includes(
        scenario === "weekly-nodate"
          ? "Generated 2026-10-05"
          : "Week of 2026-10-05"
      )
    )
    await click("Select existing local playlist")
    const selectLocal = document.querySelector<HTMLSelectElement>(
      'section[aria-label="Choose a Plex destination"] select'
    )!
    await select(selectLocal, "local")
    await click("Configure this link")
    const follow = [...document.querySelectorAll("label")]
      .find((l) => l.textContent?.includes("Follow new weekly editions"))!
      .querySelector<HTMLInputElement>("input")!
    assert.equal(follow.checked, false)
    assert.ok(
      document.body.textContent!.includes(
        "cannot run scheduled updates while closed"
      )
    )
    assert.equal(writes, 0)
    await act(() => root.unmount())
    dom.window.close()
    process.exit(0)
  }
  assert.ok(document.body.textContent!.includes("Weekly discovery"))
  assert.ok(document.body.textContent!.includes("Shared playlist"))
  await click("Weekly discovery")
  assert.equal(reads, 0, "Selecting metadata does not read every playlist")
  if (scenario === "readonly") {
    await click("Select existing local playlist")
    const local = document.querySelector<HTMLSelectElement>(
      'section[aria-label="Choose a Plex destination"] select'
    )!
    await select(local, "local")
    await click("Configure this link")
    assert.equal(
      document.querySelectorAll("dialog").length,
      1,
      "Embedded manager must not create nested modal"
    )
    const direction = [...document.querySelectorAll("label")]
      .find((l) => l.textContent?.startsWith("Sync direction"))!
      .querySelector("select")!
    assert.equal(direction.value, "import")
    assert.equal(
      direction.querySelector<HTMLOptionElement>('option[value="export"]')!
        .disabled,
      true
    )
    assert.equal(
      direction.querySelector<HTMLOptionElement>(
        'option[value="bidirectional"]'
      )!.disabled,
      true
    )
    const auto = [...document.querySelectorAll("label")]
      .find((l) => l.textContent?.includes("Automatically check"))!
      .querySelector("input")!
    assert.equal(auto.checked, false)
    assert.equal(writes, 0)
    const tabs = document.querySelector(
      '[role="tablist"][aria-label="Playlist sync configuration"]'
    )!
    const setup = tabs.querySelector<HTMLButtonElement>('[role="tab"]')!
    await act(async () => {
      setup.focus()
      setup.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true })
      )
      await settle()
    })
    assert.equal(
      (document.activeElement as HTMLElement).textContent,
      "Settings"
    )
    assert.equal(document.activeElement?.getAttribute("aria-selected"), "true")
    const panel = document.getElementById(
      document.activeElement!.getAttribute("aria-controls")!
    )!
    assert.ok(panel)
    assert.equal(
      panel.getAttribute("aria-labelledby"),
      document.activeElement!.id
    )
  } else {
    assert.equal(
      button("Create Sync").disabled,
      false,
      "Unmatched songs must not block initial creation"
    )
    assert.equal(reads, 0)
    if (scenario !== "wildcard") {
      if (scenario === "create-pending" || scenario === "create-retired") {
        await act(async () => {
          const create = button("Create Sync")
          create.click()
          create.click()
          await settle()
        })
        assert.equal(writes, 1, "Same-tick clicks have one admission")
        assert.equal(button("Creating sync").disabled, true)
        if (scenario === "create-retired")
          await act(async () => {
            useProviderStore.setState({
              provider: { ...provider, cacheScope: "other" },
            })
            useProviderStore.setState({ provider })
            await settle()
          })
        await act(async () => {
          createGate.resolve({
            intent: { id: "intent", state: "linked", destinationId: "copy" },
            link: { libraryPlaylistId: "copy" },
          })
          await settle()
        })
        if (scenario === "create-retired")
          assert.equal(
            document.body.textContent!.includes("Playlist sync configuration"),
            false
          )
      } else {
        await click("Create Sync")
        if (scenario === "create-unknown") {
          assert.equal(
            button("Create Sync").disabled,
            true,
            "Unknown create cannot be retried"
          )
          assert.ok(
            document.body.textContent!.includes("Creation needs recovery")
          )
          assert.equal(
            document.body.textContent!.includes("private URL/token"),
            false
          )
          await click("Create Sync")
        }
      }
      assert.equal(writes, 1, "Exactly one creation admission")
      assert.equal(document.querySelectorAll("dialog").length, 1)
    } else {
      await act(async () => {
        root.render(
          <PlaylistCopyDialog
            mode="import"
            remotePlaylistId={id}
            services={copyServices}
            onClose={() => {}}
          />
        )
        await settle()
      })
      assert.equal(reads, 1)
    }
    if (scenario === "wildcard") {
      const input = [...document.querySelectorAll("label")]
        .find((l) => l.textContent?.includes("Search occurrence 1"))!
        .querySelector("input")!
      assert.equal(input.maxLength, 256)
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value"
        )!.set!.call(input, "Artist Song*")
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
        input.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
        await settle()
      })
      await click("Search library")
      assert.equal(searches.at(-1), "Artist Song")
      assert.ok(document.body.textContent!.includes("Song (Live)"))
      assert.equal(
        document.body.textContent!.includes("Else — Unrelated"),
        false
      )
      assert.equal(
        button("Import this copy").disabled,
        true,
        "Wildcard suggestion never auto-selects"
      )
      await click("Artist — Song (Live)")
      assert.equal(
        button("Import this copy").disabled,
        false,
        "Explicit version selection resolves the occurrence"
      )
      assert.equal(writes, 0)
    }
  }
}
await act(() => root.unmount())
dom.window.close()
