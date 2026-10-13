import assert from "node:assert/strict"
import { mock } from "bun:test"
import { create } from "zustand"
import { JSDOM } from "jsdom"
import { act } from "react"
import { deferred, settle } from "../helpers/radioAudioFakes"
const dom = new JSDOM('<div id="root"></div>', {
  url: "https://synthetic.test/playlists",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const provider: any = { name: "Plex", cacheScope: "scope", playbackSession: {} }
const account = { service: "library:Plex", user: "scope", revision: "scope" }
const sourceAccount = {
  service: "listenbrainz",
  user: "listener",
  revision: "lease",
}
const auth = create(() => ({ username: "listener", isAuthenticated: true }))
mock.module("../../src/metadata/listenbrainz/authStore", () => ({
  useListenBrainzStore: auth,
}))
const scenario = process.argv[2]
const intent: any = {
  id: "intent",
  title: "Retained playlist",
  state: "reconcile",
  target: account,
  sourceSnapshot: {
    account: sourceAccount,
    id: "remote",
    title: "Remote",
    items: [],
  },
  ...(scenario === "known" ? { destinationId: "original" } : {}),
}
let calls: any[] = [],
  loads = 0
const gate = deferred<any>()
const store = create(() => ({
  creationIntents: [intent],
  unretainedCreations: scenario === "known" ? { intent } : {},
  links: [],
  activeCreationIds: {},
  loadCreationIntents: async () => {
    loads++
  },
  recoverCreation: async (...args: any[]) => {
    calls.push(args)
    if (scenario === "late") return gate.promise
    return {
      intent: { ...intent, state: "linked" },
      link: { libraryPlaylistId: intent.destinationId ?? args[1] },
    }
  },
}))
mock.module("../../src/stores/linkedPlaylistStore", () => ({
  useLinkedPlaylistStore: store,
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
useProviderStore.setState({ provider })
let navigations: string[] = []
mock.module("wouter", () => ({
  useLocation: () => ["/playlists", (path: string) => navigations.push(path)],
}))
const { PlaylistSyncStatus } =
  await import("../../src/components/PlaylistSync/PlaylistSyncStatus")
const { useNotificationCenterStore } =
  await import("../../src/stores/notificationCenterStore")
const { PlaylistCreationRecovery } =
  await import("../../src/components/PlaylistSync/PlaylistCreationRecovery")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
let recovered: string[] = []
if (scenario === "notices") {
  store.setState({ activeCreationIds: { intent: true } } as any)
  await act(async () => {
    root.render(<PlaylistSyncStatus />)
    await settle()
  })
  assert.equal(
    useNotificationCenterStore.getState().notifications.length,
    0,
    "Active admission is not a recovery warning"
  )
  await act(async () => {
    store.setState({ activeCreationIds: {} })
    await settle()
  })
  const center = useNotificationCenterStore.getState()
  assert.equal(center.notifications.length, 1)
  const first = center.notifications[0]
  center.dismissToast(first.id)
  center.markAllRead()
  await act(async () => {
    store.setState({ creationIntents: [{ ...intent }] })
    await settle()
  })
  const repeated = useNotificationCenterStore.getState().notifications[0]
  assert.equal(
    repeated.toastVisible,
    false,
    "Polling receipt does not repeat toast"
  )
  assert.equal(repeated.unread, false)
  assert.equal(repeated.occurrences, 1)
  const staleAction = repeated.action!
  await act(async () => {
    useProviderStore.setState({
      provider: { ...provider, cacheScope: "other" },
    })
    useProviderStore.setState({ provider })
    await settle()
  })
  staleAction.run()
  assert.deepEqual(
    navigations,
    [],
    "Retired notification action cannot navigate replacement view"
  )
  await act(async () => {
    store.setState({
      creationIntents: [],
      links: [
        {
          id: "link",
          enabled: true,
          paused: false,
          state: "ready",
          library: account,
          listenbrainz: sourceAccount,
          libraryPlaylistId: "local",
          incomplete: {
            matchingCursor: 1,
            total: 3,
            matchingDone: false,
            matchedCount: 1,
            missingOccurrenceIds: ["two", "three"],
          },
        },
      ],
    } as any)
    await settle()
  })
  const progress = useNotificationCenterStore
    .getState()
    .notifications.find((n) => n.id === "playlist.matching.link")!
  assert.equal(progress.severity, "info")
  await act(async () => {
    store.setState({
      links: [
        { ...(store.getState().links[0] as any), paused: true, state: "error" },
      ],
    } as any)
    await settle()
  })
  const paused = useNotificationCenterStore
    .getState()
    .notifications.find((n) => n.id === progress.id)!
  assert.equal(paused.severity, "warning")
  assert.equal(paused.title, "Playlist matching paused")
  assert.equal(
    paused.message.includes("browse while matching continues"),
    false
  )
  await act(async () => {
    store.setState({
      links: [
        {
          ...(store.getState().links[0] as any),
          paused: false,
          state: "ready",
        },
      ],
    } as any)
    await settle()
  })
  useNotificationCenterStore.getState().dismissToast(progress.id)
  await act(async () => {
    store.setState({
      links: [
        {
          ...(store.getState().links[0] as any),
          incomplete: {
            matchingCursor: 3,
            total: 3,
            matchingDone: true,
            matchedCount: 1,
            missingOccurrenceIds: ["two", "three"],
          },
        },
      ],
    } as any)
    await settle()
  })
  const review = useNotificationCenterStore
    .getState()
    .notifications.find((n) => n.id === progress.id)!
  assert.equal(review.severity, "warning")
  assert.equal(
    review.toastVisible,
    true,
    "Completed unresolved review escalates once"
  )
  await act(async () => {
    store.setState({ links: [] })
    await settle()
  })
  const resolved = useNotificationCenterStore
    .getState()
    .notifications.find((n) => n.id === progress.id)!
  assert.equal(resolved.active, false)
  assert.equal(resolved.action, undefined)
  await act(() => root.unmount())
  dom.window.close()
  process.exit(0)
}
await act(async () => {
  root.render(
    <PlaylistCreationRecovery
      playlists={[
        { id: "original", title: "Retained playlist", smart: false } as any,
        { id: "replacement", title: "Other", smart: false } as any,
      ]}
      onRecovered={(id) => recovered.push(id)}
    />
  )
  await settle()
})
const button = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent!.includes("Recover without creating")
  )!
assert.equal(loads, 1)
if (scenario === "known") {
  assert.equal(
    document.querySelector("select"),
    null,
    "Known destination cannot be replaced"
  )
  await act(async () => {
    button().click()
    await settle()
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], "intent")
  assert.equal(calls[0][1], undefined)
  assert.deepEqual(recovered, ["original"])
} else {
  assert.equal(button().disabled, true)
  const select = document.querySelector<HTMLSelectElement>("select")!
  await act(async () => {
    select.value = "original"
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
    await settle()
  })
  assert.equal(
    button().disabled,
    true,
    "Selection alone is not acknowledgement"
  )
  await act(async () => {
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await settle()
  })
  await act(async () => {
    const b = button()
    b.click()
    b.click()
    await settle()
  })
  assert.equal(calls.length, 1, "Concurrent recovery is single admission")
  assert.equal(calls[0][1], "original")
  assert.equal(calls[0][3], true)
  if (scenario === "late") {
    await act(async () => {
      useProviderStore.setState({
        provider: { ...provider, cacheScope: "other" },
      })
      useProviderStore.setState({ provider })
      await settle()
      gate.resolve({ intent, link: { libraryPlaylistId: "original" } })
      await settle()
    })
    assert.deepEqual(
      recovered,
      [],
      "Retired recovery must not change replacement UI"
    )
  } else assert.deepEqual(recovered, ["original"])
}
await act(() => root.unmount())
dom.window.close()
