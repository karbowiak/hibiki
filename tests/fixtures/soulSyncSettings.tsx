import { mock } from "bun:test"
import assert from "node:assert/strict"
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
const { createSoulSyncStore } =
  await import("../../src/metadata/soulsync/store")
let saved: any
const status = {
  revision: "one",
  baseUrl: "https://synthetic.test/proxy/",
  configured: true,
  enabled: true,
}
const store = createSoulSyncStore(
  {
    status: async () => status,
    configure: async (args) => {
      saved = args
      return {
        ...status,
        revision: "two",
        configured: !args.clear,
        enabled: !args.clear,
      }
    },
  },
  () => true
)
mock.module("../../src/metadata/soulsync/store", () => ({
  useSoulSyncStore: store,
}))
const { SoulSyncSettings } =
  await import("../../src/components/Settings/SoulSyncSettings")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const settle = async () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
await act(async () => root.render(<SoulSyncSettings />))
await settle()
const password = document.querySelector<HTMLInputElement>(
  'input[type="password"]'
)!
assert.equal(password.value, "")
assert.ok(document.querySelector(`label[for="${password.id}"]`))
assert.ok(document.body.textContent!.includes("leave blank only for the same server"))
await act(async () =>
  document
    .querySelector("form")!
    .dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true })
    )
)
await settle()
assert.equal(
  saved.apiKey,
  null,
  "saved native key is retained without returning it to the renderer"
)
assert.equal(store.getState().status?.configured, true)
await act(async () =>
  store.setState({
    status: {
      ...status,
      revision: "partial",
      baseUrl: "",
      configured: false,
      hasApiKey: true,
      enabled: false,
    },
  })
)
const clear = [...document.querySelectorAll("button")].find(
  (button) => button.textContent === "Clear credentials"
)!
assert.equal(
  clear.disabled,
  false,
  "a retained key can be cleared even after its URL is removed"
)
await act(async () => clear.click())
await settle()
assert.equal(saved.clear, true)
assert.equal(store.getState().status?.configured, false)
assert.equal(password.value, "")
assert.ok(document.querySelector('[role="status"]'))
await act(async () => root.unmount())
