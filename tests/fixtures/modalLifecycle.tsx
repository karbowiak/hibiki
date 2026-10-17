import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"

const dom = new JSDOM(
  "<button id='opener'>Open</button><div id='root' aria-hidden='false'></div>"
)
globalThis.window = dom.window as any
globalThis.document = dom.window.document
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
mock.module("../../src/components/shared/ArtworkImage", () => ({
  ArtworkImage: () => null,
}))
const { AppDialog } = await import("../../src/components/shared/AppDialog")
const { ImageModal } = await import("../../src/components/shared/ImageModal")
const root = createRoot(document.getElementById("root")!)
const opener = document.getElementById("opener")!
document.body.style.overflow = "scroll"
opener.focus()
let closed = 0
const view = (base: boolean, image = false, canClose = true) => (
  <>
    {base && (
      <AppDialog
        title="Details"
        onClose={() => {
          closed++
        }}
        canClose={canClose}
      >
        <button id="last">Last</button>
      </AppDialog>
    )}
    {image && (
      <ImageModal
        src="fixture.png"
        alt="Preview"
        onClose={() => {
          closed++
        }}
      />
    )}
  </>
)
const render = async (base: boolean, image = false, canClose = true) => {
  await act(() => root.render(view(base, image, canClose)))
}
const key = (value: string, shiftKey = false, ctrlKey = false) => {
  const event = new dom.window.KeyboardEvent("keydown", {
    key: value,
    shiftKey,
    ctrlKey,
    bubbles: true,
    cancelable: true,
  })
  document.activeElement!.dispatchEvent(event)
  return event
}
await render(true)
const close = document.querySelector<HTMLButtonElement>(
  '[aria-label="Close Details"]'
)!
assert.equal(document.activeElement, close)
assert.equal(document.body.style.overflow, "hidden")
assert.equal(opener.hasAttribute("inert"), true)
assert.equal(
  document.getElementById("root")!.getAttribute("aria-hidden"),
  "true"
)
key("Tab", true)
assert.equal(document.activeElement?.id, "last")
key("Tab")
assert.equal(document.activeElement, close)
opener.focus()
assert.equal(
  document.activeElement,
  close,
  "fallback must contain programmatic focus"
)
let shortcuts = 0
document.addEventListener("keydown", () => {
  shortcuts++
})
assert.equal(key("k", false, true).defaultPrevented, true)
assert.equal(shortcuts, 0)
await render(true, false, false)
key("Escape")
assert.equal(closed, 0, "an admitted write must keep its dialog open")
await render(true)
key("Escape")
assert.equal(closed, 1, "the latest close gate must apply without remounting")
await render(true, true)
const imageClose = document.querySelector<HTMLButtonElement>(
  '[aria-label="Close image"]'
)!
assert.equal(document.activeElement, imageClose)
assert.equal(close.closest("dialog")!.hasAttribute("inert"), true)
await render(true)
assert.equal(document.activeElement, close)
assert.equal(close.closest("dialog")!.hasAttribute("inert"), false)
assert.equal(document.body.style.overflow, "hidden")
await render(true, true)
await render(false, true)
assert.equal(
  document.activeElement,
  document.querySelector('[aria-label="Close image"]')
)
assert.equal(
  document.body.style.overflow,
  "hidden",
  "out-of-order close must not unlock the page"
)
await render(false)
assert.equal(document.body.style.overflow, "scroll")
assert.equal(opener.hasAttribute("inert"), false)
assert.equal(
  document.activeElement,
  opener,
  "the original opener survives out-of-order nested teardown"
)
assert.equal(
  document.getElementById("root")!.getAttribute("aria-hidden"),
  "false"
)
await act(() => root.unmount())
