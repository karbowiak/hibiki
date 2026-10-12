import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
const dom = new JSDOM("<div id='root'></div>")
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(window, "devicePixelRatio", { value: 2 })
let width = 240, primary = "rgb(0, 120, 240)", reads = 0, frameCount = 0
let resized: (() => void) | undefined
;(globalThis as any).ResizeObserver = class { constructor(callback: () => void) { resized = callback } observe() {} disconnect() {} }
globalThis.requestAnimationFrame = () => { frameCount++; return 1 }
globalThis.cancelAnimationFrame = () => {}
globalThis.getComputedStyle = (() => ({ getPropertyValue: (name: string) => ({ "--accent": "#d946ef", "--artwork-primary": primary, "--text-secondary": "#aaa" }[name] ?? "") })) as any
const calls: any[] = []
let clip = [0, 0, Infinity, Infinity], path = clip, stack: any[] = []
const context: any = {
  fillStyle: "", globalAlpha: 1,
  clearRect() { calls.length = 0 },
  save() { stack.push({ clip: [...clip], fillStyle: this.fillStyle, globalAlpha: this.globalAlpha }) },
  restore() { const previous = stack.pop(); clip = previous.clip; this.fillStyle = previous.fillStyle; this.globalAlpha = previous.globalAlpha },
  beginPath() {}, rect(x: number, y: number, w: number, h: number) { path = [x, y, w, h] },
  clip() { clip = path },
  fillRect(x: number, y: number, w: number, h: number) {
    const left = Math.max(x, clip[0]), right = Math.min(x + w, clip[0] + clip[2])
    const top = Math.max(y, clip[1]), bottom = Math.min(y + h, clip[1] + clip[3])
    if (right > left && bottom > top) calls.push({ x: left, y: top, width: right - left, height: bottom - top, color: this.fillStyle, alpha: this.globalAlpha })
  },
}
dom.window.HTMLCanvasElement.prototype.getContext = (() => context) as any
dom.window.HTMLCanvasElement.prototype.getBoundingClientRect = (() => ({ width, height: 28 })) as any
const viz = create(() => ({ getRecentSamples: () => { reads++; return new Float32Array(512) }, getFrequencyData: () => { reads++; return null }, getSampleRate: () => 48000, vizColorLow: "#0f0", vizColorMid: "#ff0", vizColorHigh: "#f00" }))
mock.module("../../src/stores/visualizerStore", () => ({ useVisualizerStore: viz }))
mock.module("../../src/stores/playerStore", () => ({ usePlayerStore: create(() => ({ isPlaying: false })) }))
mock.module("../../src/stores/easterEggStore", () => ({ useEasterEggStore: create(() => ({ rainbow: false })) }))
mock.module("../../src/stores/accentStore", () => ({ useAccentStore: create(() => ({ accent: "#d946ef" })) }))
mock.module("../../src/hooks/useVisualizationVisibility", () => ({ useVisualizationVisibility: () => true }))
const { ArtworkPaletteContext } = await import("../../src/lib/artworkPaletteContext")
const { default: VisualizerCanvas } = await import("../../src/components/VisualizerCanvas")
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const levels: any = [{ loudness: -30 }, { loudness: -5 }, { loudness: -20 }]
async function render(progressPct: number, hoverPct: number | null = null, revision = "initial", supplied = levels) {
  await act(async () => root.render(<ArtworkPaletteContext.Provider value={revision}><VisualizerCanvas mode="waveform" levels={supplied} progressPct={progressPct} hoverPct={hoverPct} /></ArtworkPaletteContext.Provider>))
}
await render(0)
assert.equal(calls.filter(call => call.alpha === 1).length, 0)
assert.equal(frameCount, 0); assert.equal(reads, 0)
assert.equal(document.querySelector("canvas")!.width, 480)
await render(50)
assert.ok(calls.some(call => call.color === primary && call.alpha === 1))
assert.ok(calls.filter(call => call.alpha === 1).every(call => call.x + call.width <= 240))
assert.ok(calls.every(call => Number.isFinite(call.x + call.y + call.width + call.height)))
await render(100)
assert.ok(calls.filter(call => call.alpha === 1).some(call => call.x > 400))
await render(50, 75)
assert.ok(calls.some(call => call.alpha === 0.4 && call.x >= 240 && call.x + call.width <= 360))
assert.ok(calls.some(call => call.alpha === 0.7 && call.x === 360 && call.height === 56))
assert.equal(context.globalAlpha, 1)
primary = "rgb(0, 180, 90)"
await render(50, null, "palette-changed")
assert.ok(calls.some(call => call.alpha === 1 && call.color === primary))
assert.equal(reads, 0); assert.equal(frameCount, 0)
width = 320; await act(async () => resized!())
assert.equal(document.querySelector("canvas")!.width, 640)
await render(50, null, "empty", null)
assert.equal(calls.length, 2); assert.equal(calls[0].height, 4)
assert.equal(calls[1].width, 320)
assert.equal(document.querySelector("canvas")!.parentElement!.className.includes("pointer-events-none"), true)
await act(async () => root.unmount()); dom.window.close()
