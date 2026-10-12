import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
globalThis.window = dom.window as any
globalThis.document = dom.window.document
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let fail: () => void
mock.module("../../src/components/shared/ArtworkImage", () => ({
  ArtworkImage: ({ src, onFailure }: any) => {
    fail = onFailure
    return <img src={src} alt="" />
  },
}))
const { AudioBrowseCard } =
  await import("../../src/components/shared/AudioBrowseCard")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
let plays = 0,
  favorites = 0,
  favorite = false,
  src = "image://localhost/fixture-one"
function render() {
  return act(async () =>
    root.render(
      <AudioBrowseCard
        title="Station"
        description="Country · 128k"
        src={src}
        openLabel="Play Station"
        onOpen={() => plays++}
        favorite={favorite}
        onFavorite={() => favorites++}
        live={true}
        active={true}
      />
    )
  )
}
await render()
const play = document.querySelector<HTMLButtonElement>(
  '[aria-label="Play Station"]'
)!
const heart = document.querySelector<HTMLButtonElement>(
  '[aria-label="Add to favorites: Station"]'
)!
assert(play)
assert(heart)
assert.equal(play.type, "button")
assert.equal(heart.closest("button button"), null)
play.focus()
assert.equal(document.activeElement, play)
await act(async () => play.click())
assert.equal(plays, 1)
heart.focus()
assert.equal(document.activeElement, heart)
await act(async () => heart.click())
assert.equal(favorites, 1)
assert.equal(plays, 1, "favorite must never start playback")
favorite = true
await render()
assert.equal(
  document
    .querySelector('[aria-label="Remove from favorites: Station"]')
    ?.getAttribute("aria-pressed"),
  "true"
)
assert.match(document.body.textContent!, /Live/)
await act(async () => fail())
assert.equal(document.querySelector("img"), null)
src = "image://localhost/fixture-two"
await render()
assert.equal(document.querySelector("img")?.getAttribute("src"), src)
await act(async () => root.unmount())
