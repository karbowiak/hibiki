import assert from "node:assert/strict"
import { mock } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
const scenario = process.argv[2] ?? "happy"
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://synthetic.test",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const commands: { name: string; args: any }[] = []
const revision = "22222222-2222-4222-8222-222222222222",
  binding = "33333333-3333-4333-8333-333333333333",
  id = "11111111-1111-4111-8111-111111111111",
  ref = "44444444-4444-4444-8444-444444444444"
let stage = 0,
  pendingResolve: ((value: any) => void) | null = null
const progress = (state: string, extra = {}) => ({
  handle: id,
  state,
  candidates: [],
  canonicalId: null,
  retryAfter: 1,
  ...extra,
})
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: async (name: string, args: any) => {
    commands.push({ name, args })
    if (name === "heya_discovery_forget") return undefined
    if (name === "heya_discovery_capability")
      return {
        available: scenario !== "denied",
        reason:
          scenario === "denied"
            ? "This server requires permission. Check Settings."
            : null,
      }
    if (name === "heya_discover") {
      if (scenario === "retired")
        return new Promise((resolve) => (pendingResolve = resolve))
      return progress("queued")
    }
    if (name === "heya_discovery_step") {
      if (args.candidateRef) {
        assert.equal(args.candidateRef, ref)
        stage = 2
        return progress("accepted")
      }
      if (scenario === "bounded") return progress("working")
      if (stage === 0) {
        stage = 1
        return progress("needs-selection", {
          candidates: [
            {
              reference: ref,
              name: "Canonical Artist",
              artists: [],
              disambiguation: "Candidate evidence",
              year: null,
            },
          ],
        })
      }
      return progress("completed", { canonicalId: id })
    }
    if (name === "heya_review_identity")
      return {
        candidate: {
          provider: "heya",
          kind: "artist",
          id,
          title: "Canonical Artist",
          artist: "Canonical Artist",
          aliases: [],
          artistCredits: [],
          identifiers: {},
          connectionId: binding,
        },
        fields: { biography: "Verified" },
        reviewedAt: 1,
      }
    throw Error("Unexpected synthetic command")
  },
}))
const { createRoot } = await import("react-dom/client")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useHeyaServiceStore } =
  await import("../../src/metadata/services/store")
const { useMetadataIdentityStore, metadataIdentityItemKey } =
  await import("../../src/stores/metadataIdentityStore")
const { useMetadataIdentityChooser } =
  await import("../../src/hooks/useMetadataIdentityChooser")
const { HeyaDiscoveryPanel } =
  await import("../../src/components/shared/HeyaDiscoveryPanel")
const provider: any = { cacheScope: "synthetic/library", capabilities: {} }
const identity: any = {
  scope: provider.cacheScope,
  kind: "artist",
  artist: "Library Artist",
  entityId: "42",
}
useProviderStore.getState().setProvider(provider)
useHeyaServiceStore.setState({
  status: {
    revision,
    connectionId: binding,
    baseUrl: "https://synthetic.test/",
    configured: true,
    enabled: true,
    hasApiKey: false,
  },
})
useMetadataIdentityStore.setState({ choices: {}, versions: {}, hydrated: true })
await Promise.resolve()
await Promise.resolve()
const originalTimer = globalThis.setTimeout,
  originalClear = globalThis.clearTimeout,
  originalNow = Date.now
let now = 0,
  next = 0
const timers = new Map<number, { due: number; run: () => void }>()
globalThis.setTimeout = ((run: () => void, delay: number) => {
  timers.set(++next, { due: now + delay, run })
  return next
}) as any
globalThis.clearTimeout = ((id: number) => timers.delete(id)) as any
Date.now = () => now
let chooser: ReturnType<typeof useMetadataIdentityChooser>
function Harness() {
  chooser = useMetadataIdentityChooser(identity)
  return (
    <>
      <HeyaDiscoveryPanel
        identity={identity}
        onReviewed={(review, lease) => chooser.adoptReviewed(review, lease)}
      />
      <button disabled={!chooser.reviewed} onClick={() => chooser.apply()}>
        Apply identity
      </button>
    </>
  )
}
const root = createRoot(document.getElementById("root")!)
await act(async () => root.render(<Harness />))
const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text
  )!
const click = async (button: HTMLButtonElement) => {
  assert.ok(button && !button.disabled)
  await act(async () =>
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
  )
}
const advance = async (ms: number) => {
  now += ms
  for (const [id, timer] of [...timers])
    if (timer.due <= now) {
      timers.delete(id)
      await act(async () => timer.run())
    }
}
assert.equal(
  commands.some((command) => command.name === "heya_discover"),
  false
)
if (scenario === "denied") {
  assert.equal(button("Discover with HeyaMetadata"), undefined)
  assert.ok(document.body.textContent?.includes("Settings"))
} else {
  await click(button("Discover with HeyaMetadata"))
  assert.equal(
    commands.filter((command) => command.name === "heya_discover").length,
    1
  )
  if (scenario === "retired") {
    await act(async () => {
      useProviderStore
        .getState()
        .setProvider({ ...provider, cacheScope: "other" })
      useProviderStore.getState().setProvider(provider)
      pendingResolve!(progress("completed", { canonicalId: id }))
    })
    assert.equal(button("Review discovered identity"), undefined)
    assert.equal(
      commands.some((command) => command.name === "heya_review_identity"),
      false
    )
  } else if (scenario === "bounded") {
    for (let i = 0; i < 61; i++) await advance(1000)
    const count = commands.filter(
      (command) => command.name === "heya_discovery_step"
    ).length
    assert.ok(count > 0 && count <= 60)
    await advance(120_000)
    assert.equal(
      commands.filter((command) => command.name === "heya_discovery_step")
        .length,
      count
    )
    await click(button("Check discovery status"))
    assert.equal(
      commands.filter((command) => command.name === "heya_discovery_step")
        .length,
      count + 1
    )
  } else {
    await advance(1000)
    assert.ok(document.body.textContent?.includes("Canonical Artist"))
    assert.equal(
      commands.some((command) => command.args.candidateRef),
      false
    )
    await click(
      [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Resolve this candidate")
      )!
    )
    assert.equal(
      commands.filter((command) => command.args.candidateRef).length,
      1
    )
    await advance(1000)
    assert.equal(
      commands.some((command) => command.name === "heya_review_identity"),
      false
    )
    assert.equal(
      useMetadataIdentityStore.getState().choices[
        metadataIdentityItemKey(identity)!
      ],
      undefined
    )
    await click(button("Review discovered identity"))
    assert.equal(chooser.reviewed!.candidate.id, id)
    assert.equal(
      useMetadataIdentityStore.getState().choices[
        metadataIdentityItemKey(identity)!
      ],
      undefined
    )
    await click(button("Apply identity"))
    assert.equal(
      useMetadataIdentityStore.getState().choices[
        metadataIdentityItemKey(identity)!
      ]!.candidate.id,
      id
    )
  }
}
await act(async () => root.unmount())
assert.equal(timers.size, 0)
globalThis.setTimeout = originalTimer
globalThis.clearTimeout = originalClear
Date.now = originalNow
dom.window.close()
