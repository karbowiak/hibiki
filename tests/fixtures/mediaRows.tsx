import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test/home" })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })
const observed = new Set<Element>()
;(globalThis as any).ResizeObserver = class { observe(element: Element) { observed.add(element) } unobserve(element: Element) { observed.delete(element) } disconnect() { observed.clear() } }
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 700 })
Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 300 })
const scrolled: number[] = []
dom.window.HTMLElement.prototype.scrollBy = (options: any) => { scrolled.push(options.left) }
mock.module("../../src/hooks/useMediaImage", () => ({ useArtistImage: () => null, useAlbumImage: () => null }))
mock.module("../../src/hooks/useTrackDrag", () => ({ useTrackDrag: () => ({}) }))
mock.module("../../src/components/shared/ArtworkImage", () => ({ ArtworkImage: ({ className, alt }: any) => <img className={className} alt={alt} />, useArtworkFailures: () => ({ failures: [], onFailure() {} }) }))
const { ScrollRow } = await import("../../src/components/ScrollRow")
const { MediaCard } = await import("../../src/components/MediaCard")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
let all = 0, shuffle = 0, play = 0
function Harness({ size = 140, linked = true }: { size?: number; linked?: boolean }) {
  return <div style={{ "--card-size": `${size}px` } as any}><ScrollRow title="Latest Releases" titleHref={linked ? "/albums" : undefined} onPlayAll={() => { all++ }} onShuffleAll={() => { shuffle++ }}><MediaCard title="Long album title" desc="Artist · 2026" thumb="fixture" scrollItem href="/album/one" onPlay={() => { play++ }} /></ScrollRow></div>
}
async function render(props: any = {}) { await act(async () => root.render(<Harness {...props} />)) }
async function click(label: string) { const target = document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement; assert.ok(target); assert.equal(target.type, "button"); await act(async () => target.click()) }
await render()
assert.equal(document.querySelector("h2")!.textContent, "Latest Releases")
assert.equal(document.querySelector("h2 a")!.getAttribute("href"), "/albums")
assert.ok(observed.has(document.querySelector(".media-card")!))
assert.equal(document.querySelector(".media-card__title")!.textContent, "Long album title")
assert.equal(document.querySelector(".media-card__meta")!.textContent, "Artist · 2026")
assert.ok(document.querySelector(".media-card__caption--play"))
assert.equal(document.querySelector(".media-card__gradient")!.getAttribute("aria-hidden"), "true")
assert.equal(document.querySelector("a button"), null)
await click("Play Long album title"); assert.equal(play, 1); assert.equal(all, 0)
await click("Play all"); assert.equal(all, 1); assert.equal(play, 1)
await click("Shuffle all"); assert.equal(shuffle, 1)
await click("Scroll left"); await click("Scroll right"); assert.deepEqual(scrolled, [-440, 440])
await click("Expand"); assert.ok(document.querySelector(".scroll-row-grid")); assert.equal(document.querySelector('[aria-label="Collapse"]')!.getAttribute("aria-expanded"), "true")
await click("Collapse"); assert.equal(document.querySelector(".scroll-row-grid"), null)
await render({ size: 280, linked: false }); assert.equal(document.querySelector("h2")!.textContent, "Latest Releases"); assert.equal(document.querySelector("h2 a"), null)
assert.equal((document.querySelector(".media-card") as HTMLElement).style.width, "var(--card-size, 160px)")
await act(async () => root.unmount()); dom.window.close()
