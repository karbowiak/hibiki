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
let calls = 0,
  finish!: (value: any) => void
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (name: string) => {
    if (name === "theaudiodb_lookup") {
      calls++
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    throw new Error("Unexpected synthetic command: " + name)
  },
}))
const { createRoot } = await import("react-dom/client")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useMetadataIdentityStore } =
  await import("../../src/stores/metadataIdentityStore")
const { useTheAudioDbStore } =
  await import("../../src/metadata/theaudiodb/store")
const { useTheAudioDbArtwork } =
  await import("../../src/hooks/useTheAudioDbArtwork")
const provider: any = { cacheScope: "scope", isOffline: false }
const status = {
  revision: "A",
  enabled: true,
  configured: true,
  hasApiKey: true,
  baseUrl: "https://www.theaudiodb.com",
}
useProviderStore.setState({ provider })
useMetadataIdentityStore.setState({ hydrated: true })
useTheAudioDbStore.setState({ status })
const result = (revision = "A") => ({
  status: "ready",
  item: {
    id: "12",
    kind: "artist",
    artist: "Artist",
    title: null,
    mbid: null,
    revision,
    fields: {},
    posters: [
      { id: "thumb", url: "https://r2.theaudiodb.com/images/artist.jpg" },
      { id: "bad", url: "https://evil.example/image" },
    ],
    backgrounds: [],
    url: "https://www.theaudiodb.com/artist/12",
  },
})
let rendered: ReturnType<typeof useTheAudioDbArtwork>,
  allow = false
const revise = (url: string | null) => url
function Fixture() {
  rendered = useTheAudioDbArtwork(
    "artist",
    "Artist",
    null,
    "12",
    "background",
    "scope",
    revise,
    allow
  )
  return <div>{rendered.images.length}</div>
}
const root = createRoot(document.getElementById("root")!)
await act(async () => {
  root.render(<Fixture />)
})
assert.equal(calls, 0)
await act(async () => {
  useProviderStore.setState({ provider: { ...provider, isOffline: true } })
  allow = true
  root.render(<Fixture />)
})
assert.equal(calls, 0)
await act(async () => {
  useProviderStore.setState({ provider })
  root.render(<Fixture />)
})
assert.equal(calls, 1)
const retiredFinish = finish
await act(async () => {
  useProviderStore.setState({ provider: { ...provider, cacheScope: "other" } })
  useProviderStore.setState({ provider })
  retiredFinish(result())
  await Promise.resolve()
})
assert.equal(rendered!.images.length, 0)
assert.equal(calls, 2)
await act(async () => {
  finish(result())
  await Promise.resolve()
})
assert.equal(rendered!.images.length, 1)
assert.match(rendered!.images[0].label!, /reused as background/)
assert.match(rendered!.images[0].provenance!, /TheAudioDB/)
assert.ok(rendered!.images[0].url.includes("scope=scope"))
await act(async () => {
  useTheAudioDbStore.setState({ status: { ...status, enabled: false } })
})
assert.equal(rendered!.images.length, 0)
await act(async () => {
  useTheAudioDbStore.setState({ status: { ...status, revision: "B" } })
})
assert.equal(calls, 3)
await act(async () => {
  finish(result("A"))
  await Promise.resolve()
})
assert.equal(rendered!.images.length, 0)
await act(async () => {
  root.unmount()
})
dom.window.close()
