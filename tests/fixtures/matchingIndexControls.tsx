import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { deferred } from "../helpers/radioAudioFakes"

const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
const oldInterval = globalThis.setInterval, oldClear = globalThis.clearInterval
let poll = () => {}
globalThis.setInterval = ((callback: () => void) => { poll = callback; return 1 }) as any
globalThis.clearInterval = (() => {}) as any
const status = (paused = false) => ({ paused, tasks: [], health: { refreshes: [], filters: {} } })
const firstRead = deferred<any>(), control = deferred<any>()
let reads = 0, controls = 0
let provider: any = { cacheScope: "scope", playbackSession: {}, matchingIndexStatus: () => { reads++; return firstRead.promise },
  matchingIndexControl: () => { controls++; return control.promise } }
mock.module("../../src/hooks/useProviderOwner", () => ({ useProviderOwner: () => ({ provider, scope: provider.cacheScope, session: provider.playbackSession }) }))
mock.module("../../src/stores/providerStore", () => ({ useProviderStore: { getState: () => ({ provider }) } }))
const { MatchingIndexControls } = await import("../../src/components/MatchingIndexControls")
const root = createRoot(document.getElementById("root")!)
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === name)!
try {
  await act(async () => root.render(<MatchingIndexControls />))
  assert.equal(reads, 1)
  await act(async () => { button("Pause indexing").click(); button("Pause indexing").click() })
  assert.equal(controls, 1, "duplicate clicks cannot admit duplicate controls")
  await act(async () => poll())
  assert.equal(reads, 1, "polling must yield to a pending control")
  await act(async () => firstRead.resolve(status(false)))
  assert.ok(!document.body.textContent!.includes("Playback preparation takes priority"), "an old status read cannot replace a pending pause")
  await act(async () => control.resolve(status(true)))
  assert.ok(document.body.textContent!.includes("Paused."))
  assert.equal(button("Resume indexing").disabled, false)

  const oldControl = deferred<any>()
  provider.matchingIndexControl = () => oldControl.promise
  await act(async () => button("Resume indexing").click())
  provider = { cacheScope: "new-scope", playbackSession: {}, matchingIndexStatus: async () => status(true), matchingIndexControl: async () => status(false) }
  await act(async () => root.render(<MatchingIndexControls />))
  await act(async () => oldControl.resolve(status(false)))
  assert.ok(document.body.textContent!.includes("Paused."), "old-library controls cannot change the replacement's status")
  assert.equal(button("Resume indexing").disabled, false)
  await act(async () => button("Resume indexing").click())
  assert.ok(document.body.textContent!.includes("Playback preparation takes priority"))
} finally {
  await act(async () => root.unmount())
  globalThis.setInterval = oldInterval; globalThis.clearInterval = oldClear
  dom.window.close()
}
