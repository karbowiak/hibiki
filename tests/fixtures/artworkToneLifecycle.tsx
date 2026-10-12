import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { deferred } from "../helpers/radioAudioFakes"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
globalThis.window = dom.window as any
globalThis.document = dom.window.document
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let blocked = true
const values = new Map<string, string>()
Object.defineProperty(globalThis, "localStorage", {
  get: () => ({
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      if (blocked) throw Error("blocked")
      values.set(key, value)
    },
    removeItem(key: string) {
      values.delete(key)
    },
  }),
})
document.documentElement.style.setProperty("--accent", "#112233")
const pending: Array<{
    src: string
    key: string
    reply: ReturnType<typeof deferred<any>>
  }> = [],
  cache = new Map<string, any>()
mock.module("../../src/lib/artworkTone", () => ({
  artworkToneSampler: {
    peek: (key: string) => cache.get(key),
    sample: (src: string, key: string) => {
      const reply = deferred<any>()
      pending.push({ src, key, reply })
      return reply.promise
    },
  },
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const provider: any = { cacheScope: "first", capabilities: {} }
useProviderStore.getState().setProvider(provider)
const { useArtworkAppearanceStore: appearance } =
  await import("../../src/stores/artworkAppearanceStore")
const { localPreferencePersistence: persistence } =
  await import("../../src/stores/localPreferenceStorage")
const { useArtworkTone } = await import("../../src/hooks/useArtworkTone")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
let styles: any
function Harness({ src }: { src: string | null }) {
  styles = useArtworkTone(src)
  return <div style={styles} />
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
async function render(src: string | null) {
  await act(async () => {
    root.render(<Harness src={src} />)
    await flush()
  })
}
const tone = (rgb: string) => ({
  primary: `rgb(${rgb})`,
  primaryRgb: rgb,
  ink: "#ffffff",
  secondary: "rgb(1 2 3)",
  secondaryRgb: "1 2 3",
})
async function settle(index: number, value: any) {
  await act(async () => {
    cache.set(pending[index].key, value)
    pending[index].reply.resolve(value)
    await flush()
  })
}
await render("A")
assert.equal(styles, undefined)
await render("B")
assert.equal(styles, undefined)
await settle(0, tone("200 1 1"))
assert.equal(styles, undefined)
await settle(1, tone("1 200 1"))
assert.equal(styles["--artwork-primary-rgb"], "1 200 1")
provider.cacheScope = "second"
await render("B")
assert.equal(styles, undefined)
await settle(2, tone("1 1 200"))
assert.equal(styles["--artwork-primary-rgb"], "1 1 200")
await render("C")
assert.equal(styles, undefined)
await act(async () => {
  useProviderStore
    .getState()
    .setProvider({ cacheScope: "third", capabilities: {} } as any)
  await flush()
})
await settle(3, tone("200 200 1"))
assert.equal(styles, undefined)
await settle(4, tone("1 200 200"))
assert.equal(styles["--artwork-primary-rgb"], "1 200 200")
await act(async () => appearance.getState().setArtworkColorsEnabled(false))
assert.equal(styles, undefined)
await persistence.flush()
assert(
  persistence
    .snapshot()
    .some(
      (issue) => issue.key === "plex-artwork-colors" && issue.hasPendingChanges
    )
)
blocked = false
await persistence.retry()
assert.equal(values.get("plex-artwork-colors"), "0")
assert.equal(
  document.documentElement.style.getPropertyValue("--accent"),
  "#112233"
)
await act(async () => root.unmount())
