import assert from "node:assert/strict"
import { mock } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { deferred, settle } from "../helpers/radioAudioFakes"
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://synthetic.test",
})
const network = { onLine: false, userAgent: "synthetic", platform: "MacIntel" }
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, "navigator", {
  value: network,
  configurable: true,
})
let servicesCalls = 0,
  admitted = 0
let gate: ReturnType<typeof deferred<void>> | undefined
mock.module("../../src/playlistSync/linkedServices", () => ({
  linkedSyncServices: async (
    _provider: unknown,
    _link: unknown,
    current: () => boolean
  ) => {
    servicesCalls++
    if (gate) await gate.promise
    return {
      current,
      repository: { load: async () => [] },
      library: { mutate: async () => {} },
      listenbrainz: { mutate: async () => {} },
    }
  },
}))
mock.module("../../src/playlistSync/linkedExecution", () => ({
  checkLinkedPlaylist: async (
    link: unknown,
    services: { current(): boolean }
  ) => {
    if (!services.current()) throw Error("retired")
    admitted++
    return link
  },
}))
const { createRoot } = await import("react-dom/client")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useListenBrainzStore } =
  await import("../../src/metadata/listenbrainz/authStore")
const { useLinkedPlaylistStore } =
  await import("../../src/stores/linkedPlaylistStore")
const { providerPlaylistAccount } =
  await import("../../src/playlistSync/provider")
const { useLinkedPlaylistSync } =
  await import("../../src/hooks/useLinkedPlaylistSync")
await settle()
const provider: any = {
  name: "Plex",
  cacheScope: "scope",
  playbackSession: 1,
  isOffline: false,
  mutatePlaylistOccurrence: async () => {},
}
const link: any = {
  id: "link",
  enabled: true,
  paused: false,
  library: providerPlaylistAccount(provider),
  listenbrainz: { user: "owner" },
}
useProviderStore.setState({ provider })
useListenBrainzStore.setState({ isAuthenticated: true, username: "owner" })
useLinkedPlaylistStore.setState({
  links: [link],
  error: null,
  load: async () => {},
  publish: () => {},
})
function Probe() {
  useLinkedPlaylistSync()
  return null
}
let root = createRoot(document.getElementById("root")!)
await act(async () => {
  root.render(<Probe />)
  await settle()
})
assert.equal(servicesCalls, 0, "offline poll must not start service reads")
await act(async () => root.unmount())
network.onLine = true
root = createRoot(document.getElementById("root")!)
await act(async () => {
  root.render(<Probe />)
  await settle()
})
assert.equal(admitted, 1, "explicit enabled link polls online")
await act(async () => root.unmount())
useLinkedPlaylistStore.setState({ links: [{ ...link, paused: true }] })
root = createRoot(document.getElementById("root")!)
await act(async () => {
  root.render(<Probe />)
  await settle()
})
assert.equal(servicesCalls, 1, "paused link must not start service reads")
await act(async () => root.unmount())
useLinkedPlaylistStore.setState({ links: [link] })
gate = deferred<void>()
root = createRoot(document.getElementById("root")!)
await act(async () => {
  root.render(<Probe />)
  await settle()
})
assert.equal(servicesCalls, 2)
await act(async () => {
  useProviderStore.setState({ provider: null })
  gate!.resolve()
  await settle()
})
assert.equal(
  admitted,
  1,
  "retired account cannot proceed after a late service lease"
)
await act(async () => root.unmount())
dom.window.close()
