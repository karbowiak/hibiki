import assert from "node:assert/strict"
import { mock } from "bun:test"
import { act, createElement } from "react"
import { JSDOM } from "jsdom"
import { create } from "zustand"
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://synthetic.test",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
})
// Pixel analysis is covered separately; this fixture exercises frame ownership.
mock.module("../../src/lib/focalPoint", () => ({
  detectFocalPoint: async () => ({ x: 0.5, y: 0.25 }),
}))
let route = "/home",
  selected: any = null,
  owners: string[] | undefined = undefined
const tones: (string | null)[] = []
const provider = { cacheScope: "scope" }
const providerStore = create(() => ({ provider }))
mock.module("../../src/stores/providerStore", () => ({
  useProviderStore: providerStore,
}))
mock.module("wouter", () => ({ useLocation: () => [route, () => {}] }))
mock.module("../../src/hooks/useAmbientArtwork", () => ({
  useAmbientArtwork: () => ({
    artwork: selected,
    playlistOwners: owners,
    next: () => {},
    canRotate: false,
    onFailure: () => {
      selected = null
    },
  }),
}))
mock.module("../../src/hooks/useArtworkTone", () => ({
  useArtworkTone: (src: string | null) => {
    tones.push(src)
    return src ? { "--synthetic-tone": "red" } : undefined
  },
}))
mock.module("../../src/lib/artworkUiPalette", () => ({
  artworkUiPalette: (tone: any) => tone,
}))
mock.module("../../src/stores/artworkAppearanceStore", () => ({
  useArtworkAppearanceStore: create(() => ({
    backgroundArtworkEnabled: true,
    backgroundRotationEnabled: false,
    artworkColorsEnabled: true,
    interfaceOpacity: 1,
    setBackgroundRotationEnabled: () => {},
  })),
}))
mock.module("../../src/stores/customColorStore", () => ({
  useCustomColorStore: create(() => ({ enabled: false, overrides: {} })),
}))
mock.module("../../src/stores/themeStore", () => ({
  getTheme: () => "dark",
  subscribeTheme: () => () => {},
}))
mock.module("../../src/components/shared/ArtworkImage", () => ({
  ArtworkImage: ({ onFailure, ...props }: any) =>
    createElement("img", { ...props, onError: () => onFailure?.(props.src) }),
}))
const { createRoot } = await import("react-dom/client")
const { ArtworkShell } = await import("../../src/components/ArtworkShell")
const root = createRoot(document.getElementById("root")!)
const art = (src: string, owner: string) => ({
  src: `https://synthetic.test/${src}`,
  route,
  owner,
  origin: "pool",
  scope: "scope",
  position: "50% 50%",
})
const render = async () =>
  act(async () =>
    root.render(
      <ArtworkShell>
        <div>Page</div>
      </ArtworkShell>
    )
  )
const frames = () => [...document.querySelectorAll(".app-artwork-frame")]
const load = async () => {
  const image = document.querySelector(
    ".app-artwork-staging"
  ) as HTMLImageElement
  assert.ok(image)
  Object.defineProperties(image, {
    naturalWidth: { value: 1000 },
    naturalHeight: { value: 1000 },
  })
  await act(async () => {
    image.dispatchEvent(new dom.window.Event("load", { bubbles: true }))
    await Promise.resolve()
  })
}
try {
  selected = art("unrelated", "ambient-pool")
  await render()
  await load()
  assert.equal(frames().length, 1)
  route = "/playlist/p"
  owners = []
  selected = null
  await render()
  assert.equal(frames().length, 0)
  assert.equal(tones.at(-1), null)
  assert.equal(
    document
      .querySelector(".app-artwork-shell")!
      .getAttribute("style")
      ?.includes("synthetic-tone"),
    false
  )
  owners = ["member-one", "member-two"]
  selected = art("one", "member-one")
  await render()
  await load()
  assert.equal(frames().length, 1)
  selected = art("two", "member-two")
  await render()
  assert.equal(
    frames().length,
    1,
    "same-playlist old member stays visible while next member loads"
  )
  await load()
  assert.equal(frames().length, 2, "same-playlist rotation retains crossfade")
  owners = ["member-two"]
  await render()
  assert.equal(
    frames().length,
    1,
    "removed member cannot remain in retiring pixels"
  )
  const oldImage = document.querySelector(".app-artwork-frame img")!
  selected = null
  owners = []
  await render()
  assert.equal(frames().length, 0)
  assert.equal(tones.at(-1), null)
  await act(() =>
    oldImage.dispatchEvent(new dom.window.Event("load", { bubbles: true }))
  )
  assert.equal(frames().length, 0)
  route = "/playlist/q"
  owners = ["q"]
  selected = art("q", "q")
  await render()
  assert.equal(
    frames().length,
    0,
    "new playlist never reveals old playlist ready pixels"
  )
  const staging = document.querySelector(".app-artwork-staging")!
  await act(() =>
    staging.dispatchEvent(new dom.window.Event("error", { bubbles: true }))
  )
  await render()
  assert.equal(frames().length, 0)
  assert.equal(tones.at(-1), null)
  route = "/artist/a"
  owners = undefined
  selected = art("artist", "detail")
  await render()
  await load()
  assert.equal(frames().length > 0, true)
  route = "/library"
  selected = art("library", "ambient-pool")
  await render()
  assert.equal(
    frames().length > 0,
    true,
    "general route transitions keep existing smooth handoff"
  )
} finally {
  await act(() => root.unmount())
  dom.window.close()
}
