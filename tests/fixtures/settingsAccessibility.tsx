import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { renderToStaticMarkup } from "react-dom/server"
const dom = new JSDOM("", { url: "https://hibiki.test" })
dom.window.matchMedia = (() => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
})) as any
globalThis.window = dom.window as any
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
globalThis.location = dom.window.location
mock.module("../../src/backends/plex/definition", () => ({
  plexBackend: {
    capabilities: { search: true, playlists: true, lyrics: false },
    SettingsComponent: () => <button>Fixture connection configuration</button>,
  },
}))
const metadata = {
  id: "fixture",
  name: "Fixture metadata",
  icon: () => null,
  capabilities: { artistBio: true },
  SettingsComponent: () => <button>Fixture metadata configuration</button>,
}
mock.module("../../src/metadata", () => ({
  metadataBackends: [metadata],
  getMetadataBackend: () => metadata,
}))
mock.module("../../src/components/ImageCacheControls", () => ({
  ImageCacheControls: () => <button>Fixture artwork cache</button>,
}))
mock.module("../../src/i18n", () => ({ setLanguage() {} }))
mock.module("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en" }, t: (s: string) => s }),
}))
const { SettingsPage } = await import("../../src/components/Pages/Settings")
function page(section: string) {
  return new JSDOM(renderToStaticMarkup(<SettingsPage section={section} />))
    .window.document
}
for (const section of ["plex", "metadata/fixture"]) {
  const doc = page(section),
    disclosure = doc.querySelector("details")!
  assert(disclosure)
  assert.equal(disclosure.hasAttribute("open"), false)
  assert.equal(
    disclosure.querySelector("summary")?.textContent,
    "Supported features"
  )
  const summary = disclosure.querySelector("summary")!
  summary.click()
  assert.equal(disclosure.open, true)
  summary.click()
  assert.equal(disclosure.open, false)
  const configuration = doc.querySelector("main button")!
  assert.equal(
    Boolean(
      configuration.compareDocumentPosition(disclosure) &
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING
    ),
    true
  )
  assert.equal(
    doc.querySelector('[aria-current="page"]')?.textContent?.trim(),
    section === "plex" ? "Plex" : "Metadata"
  )
}
for (const section of ["general", "appearance", "eastereggs"]) {
  const doc = page(section)
  for (const toggle of doc.querySelectorAll('[role="switch"]')) {
    assert(toggle.getAttribute("aria-label"), `${section}: unnamed switch`)
    assert.match(toggle.className, /focus-visible:outline-2/)
    assert(["true", "false"].includes(toggle.getAttribute("aria-checked")!))
  }
  if (section === "appearance") {
    const theme = doc.querySelector('[role="group"][aria-label="Theme"]')!
    assert(theme)
    assert.equal(theme.querySelectorAll('[aria-pressed="true"]').length, 1)
    assert.equal(theme.querySelectorAll("[aria-pressed]").length, 3)
  }
}
