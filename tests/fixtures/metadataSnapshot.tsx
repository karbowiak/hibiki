import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import type { MetadataResult } from "../../src/metadata/core/types"
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://synthetic.test",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const auth = create(() => ({ hasApiKey: true, username: "synthetic" }))
mock.module("../../src/metadata/lastfm/authStore", () => ({
  useLastfmStore: auth,
}))
mock.module("../../src/stores/metadataSourceStore", () => ({
  useMetadataSourceStore: create(() => ({ priority: ["plex", "apple"] })),
}))
const pending: { request: any; resolve: (value: MetadataResult) => void }[] = []
let invalidations = 0
mock.module("../../src/metadata/core/existingProviders", () => ({
  existingMetadataProviders: () => [
    {
      id: "apple",
      fields: { album: ["genres"] },
      transportPolicy: "synthetic",
      lookup: (request: any) =>
        new Promise((resolve) => pending.push({ request, resolve })),
      invalidate: () => {
        invalidations++
      },
    },
  ],
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useMetadataSnapshot } =
  await import("../../src/hooks/useMetadataSnapshot")
const { metadataIdentityKey } = await import("../../src/metadata/core/resolve")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const provider: any = { cacheScope: "account-a", capabilities: {} }
useProviderStore.getState().setProvider(provider)
const identity: any = {
  kind: "album",
  artist: "Artist",
  title: "Album",
  entityId: "1",
  scope: "account-a",
}
const album: any = {
  id: "1",
  title: "Album",
  artistName: "Artist",
  thumbUrl: null,
  summary: "Library summary",
  genres: ["Library"],
}
let latest: ReturnType<typeof useMetadataSnapshot>
function Harness({
  open = true,
  id = identity,
  choice = "apple",
}: {
  open?: boolean
  id?: any
  choice?: string
}) {
  latest = useMetadataSnapshot(
    open ? id : null,
    open ? album : null,
    choice === "none"
      ? undefined
      : {
          scope: id.scope,
          identityKey: metadataIdentityKey(id),
          source: choice as any,
        }
  )
  return <output>{latest.resolveField("genres")?.value.join(",")}</output>
}
const render = async (props: any = {}) =>
  act(async () => {
    root.render(<Harness {...props} />)
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
const settle = async () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
const finish = async (index: number, genre: string) => {
  pending[index].resolve({
    status: "ready",
    snapshot: {
      source: "apple",
      identity: pending[index].request,
      fields: { genres: [genre] },
      match: { kind: "exact-name", reason: "synthetic" },
      observedAt: 1,
    },
  })
  await settle()
}
await render({ open: false, choice: "none" })
assert.equal(pending.length, 0)
await render()
assert.equal(pending.length, 1)
assert.equal(document.querySelector("output")!.textContent, "Library")
await render()
assert.equal(
  pending.length,
  1,
  "recreated selection object must not reissue lookup"
)
await finish(0, "Public")
assert.equal(document.querySelector("output")!.textContent, "Public")
await act(async () => {
  assert.equal(latest!.refresh("apple"), true)
})
await settle()
assert.equal(invalidations, 1)
assert.equal(pending.length, 2)
await render({ open: false })
await finish(1, "Late refresh")
assert.equal(latest!.snapshots.length, 0)
await render()
assert.equal(pending.length, 3)
await act(async () =>
  useProviderStore
    .getState()
    .setProvider({ ...provider, cacheScope: "account-b" })
)
await settle()
assert.equal(
  latest!.snapshots.length,
  0,
  "old library model cannot appear under replacement scope"
)
await finish(2, "Old account")
assert.equal(latest!.snapshots.length, 0)
await render({ id: { ...identity, scope: "account-b" } })
assert.equal(pending.length, 4)
await finish(3, "New account")
assert.equal(document.querySelector("output")!.textContent, "New account")
await act(async () => useProviderStore.getState().clearProvider())
await render({ open: false, choice: "none" })
assert.equal(latest!.isLoading, false)
assert.deepEqual(latest!.snapshots, [])
await act(async () => root.unmount())
