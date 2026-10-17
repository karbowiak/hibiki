import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { deferred } from "../helpers/radioAudioFakes"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { createRoot } = await import("react-dom/client")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useWindowedPages, useCachedWindowedPages } =
  await import("../../src/hooks/useWindowedPages")
const pending = [
  deferred<any>(),
  deferred<any>(),
  deferred<any>(),
  deferred<any>(),
]
let calls = 0,
  visible: any,
  cached: any
const provider: any = { cacheScope: "a", playbackSession: {} }
useProviderStore.setState({ provider })
function Reader() {
  cached = useCachedWindowedPages("playlist:1")
  return null
}
function View() {
  visible = useWindowedPages("playlist:1", () => pending[calls++].promise)
  return null
}
const root = createRoot(document.getElementById("root")!)
try {
  await act(() =>
    root.render(
      <>
        <Reader />
        <View />
      </>
    )
  )
  assert.equal(calls, 1, "cache-only consumers start no requests")
  await act(() => {
    provider.cacheScope = "b"
    provider.playbackSession = {}
    useProviderStore.setState({ provider })
  })
  assert.equal(
    calls,
    2,
    "a reused provider creates a new owned window after reconnect"
  )
  await act(() => pending[1].resolve({ items: ["new"], total: 1 }))
  await act(() => pending[0].resolve({ items: ["old"], total: 1 }))
  assert.equal(visible.getItem(0), "new")
  assert.equal(cached, visible)
  await act(() =>
    window.dispatchEvent(
      new dom.window.CustomEvent("collection-cache-updated", {
        detail: "playlist:1",
      })
    )
  )
  assert.equal(calls, 3)
  assert.equal(cached, visible, "invalidation keeps the active shared window")
  assert.equal(cached.getItem(0), "new", "visible rows survive a refresh")
  await act(() => pending[2].resolve({ items: ["edited"], total: 1 }))
  assert.equal(cached.getItem(0), "edited")
  await act(() => {
    provider.cacheScope = "c"
    useProviderStore.setState({ provider })
  })
  assert.equal(
    calls,
    4,
    "a scope change retires reads even without a replacement session token"
  )
  await act(() => pending[3].resolve({ items: ["third"], total: 1 }))
  assert.equal(cached.getItem(0), "third")
} finally {
  await act(() => root.unmount())
  dom.window.close()
}
