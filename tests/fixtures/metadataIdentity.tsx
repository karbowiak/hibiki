import assert from "node:assert/strict"
import { mock } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://synthetic.test",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const calls: { command: string; args: any; resolve: (value: any) => void }[] =
  []
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: (command: string, args: any) =>
    new Promise((resolve) => calls.push({ command, args, resolve })),
}))
const { createRoot } = await import("react-dom/client")
const { useMetadataIdentityChooser } =
  await import("../../src/hooks/useMetadataIdentityChooser")
const { useReviewedArtwork } =
  await import("../../src/hooks/useReviewedArtwork")
const { useMetadataIdentityStore } =
  await import("../../src/stores/metadataIdentityStore")
const { useProviderStore } = await import("../../src/stores/providerStore")
const root = createRoot(document.getElementById("root")!)
const provider: any = { cacheScope: "account/library", capabilities: {} }
const identity: any = {
  kind: "album",
  artist: "Library Artist",
  title: "Library title",
  entityId: "42",
  scope: provider.cacheScope,
}
const id = "51497a0b-fd77-48dc-9cb0-bfe8ce205173"
const candidate: any = {
  provider: "musicbrainz",
  kind: "album",
  id,
  title: "残夢",
  artist: "Ado",
  aliases: [{ name: "Zanmu", locale: "en" }],
  artistCredits: [{ name: "Ado" }],
  identifiers: { releaseGroupMbid: id },
}
let chooser: ReturnType<typeof useMetadataIdentityChooser>,
  art: ReturnType<typeof useReviewedArtwork>
function Harness() {
  chooser = useMetadataIdentityChooser(identity)
  art = useReviewedArtwork("coverartarchive", identity, true)
  return null
}
await act(async () => {
  useMetadataIdentityStore.setState({
    choices: {},
    versions: {},
    hydrated: true,
  })
  useProviderStore.getState().setProvider(provider)
  root.render(<Harness />)
})
assert.equal(calls.length, 0, "mount must not initiate candidate searches")
let search: Promise<void>
await act(async () => {
  search = chooser.search("musicbrainz", "Zanmu")
})
assert.equal(calls[0].command, "musicbrainz_search_identities")
await act(async () => {
  calls.shift()!.resolve([candidate])
  await search
})
assert.equal(chooser.candidates.length, 1)
assert.equal(chooser.selected, null)
assert.equal(chooser.apply(), false)
let review: Promise<void>
await act(async () => {
  review = chooser.review(candidate)
})
assert.deepEqual(calls[0].args, { kind: "album", id })
await act(async () => {
  calls
    .shift()!
    .resolve({ candidate, fields: { tags: ["Pop"] }, reviewedAt: 1 })
  await review
})
await act(async () => {
  assert.equal(chooser.apply(), true)
})
assert.equal(chooser.resolution!.original.title, "Library title")
assert.equal(chooser.resolution!.lookupTitle, "残夢")
assert.equal(calls[0].command, "coverartarchive_get_album")
assert.equal(calls[0].args.releaseGroupMbid, id)
// A reset retires the exact-ID image before its response completes.
await act(async () => {
  chooser.reset()
  calls
    .shift()!
    .resolve({ cover_url: "https://coverartarchive.org/synthetic.jpg" })
})
assert.equal(art.resolution!.choice, null)
assert.equal(art.data, null)
await act(async () => {
  search = chooser.search("musicbrainz", "second")
})
await act(async () => {
  useProviderStore.getState().setProvider({ ...provider, cacheScope: "other" })
  useProviderStore.getState().setProvider(provider)
  calls.shift()!.resolve([candidate])
  await search
})
assert.equal(
  chooser.candidates.length,
  0,
  "retired A-B-A response must not publish"
)
await act(async () => {
  useProviderStore.getState().setProvider({ ...provider, isOffline: true })
})
await act(async () => {
  await chooser.search("musicbrainz", "offline")
})
assert.equal(calls.length, 0, "offline must not issue identity searches")
// Exact reviewed album IDs work without an invented single artist credit.
const { useFanartServiceStore, useHeyaServiceStore } =
  await import("../../src/metadata/services/store")
let source: "fanart" | "heya" = "fanart"
function SourceHarness() {
  art = useReviewedArtwork(source, identity, true)
  return null
}
const revision = crypto.randomUUID(),
  binding = crypto.randomUUID()
await act(async () => {
  useProviderStore.getState().setProvider(provider)
  useFanartServiceStore.setState({
    status: {
      revision,
      configured: true,
      enabled: true,
      hasApiKey: true,
      baseUrl: "https://webservice.fanart.tv/v3.2/",
    },
  })
  useMetadataIdentityStore
    .getState()
    .setReviewed(identity, { candidate, fields: {}, reviewedAt: 1 })
  root.render(<SourceHarness />)
})
assert.equal(calls[0].command, "fanart_get_album")
assert.equal(calls[0].args.releaseGroupMbid, id)
assert.equal(calls[0].args.artistMbid, null)
await act(async () => {
  calls
    .shift()!
    .resolve({
      mbid: id,
      revision,
      posters: [{ id: "12", url: "https://assets.fanart.tv/synthetic.jpg" }],
      backgrounds: [],
    })
})
assert.equal(art.data!.posters[0].id, "12")
source = "heya"
const heyaId = "fde1a1f9-a32e-4abf-b0de-f894c6720f4a"
await act(async () => {
  useHeyaServiceStore.setState({
    status: {
      revision,
      connectionId: binding,
      configured: true,
      enabled: true,
      hasApiKey: false,
      baseUrl: "https://synthetic.test/",
    },
  })
  useMetadataIdentityStore
    .getState()
    .setReviewed(identity, {
      candidate: {
        ...candidate,
        provider: "heya",
        id: heyaId,
        connectionId: binding,
      },
      fields: {},
      reviewedAt: 1,
    })
  root.render(<SourceHarness />)
})
assert.equal(calls[0].command, "heya_get_metadata")
assert.equal(calls[0].args.selectedId, heyaId)
assert.equal(calls[0].args.selectedConnectionId, binding)
await act(async () => {
  calls
    .shift()!
    .resolve({
      status: "ready",
      item: {
        id: heyaId,
        artist: identity.artist,
        title: identity.title,
        revision,
        posters: [],
        backgrounds: [
          { id, url: `heyametadata://image/${id}?serviceRevision=${revision}` },
        ],
      },
    })
})
assert.equal(art.data!.backgrounds[0].id, id)
await act(async () => {
  useHeyaServiceStore.setState({
    status: {
      ...useHeyaServiceStore.getState().status!,
      revision: crypto.randomUUID(),
      connectionId: crypto.randomUUID(),
    },
  })
})
assert.equal(
  art.resolution!.choice,
  null,
  "retargeted service cannot reuse reviewed IDs"
)
assert.equal(art.data, null)
assert.equal(calls.length, 0)
await act(async () => {
  root.unmount()
})
dom.window.close()
