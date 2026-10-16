import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"

const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const selected: string[] = []
const store = create<any>((set) => ({
  presetBrowserOpen: true, currentPresetName: 'First preset', favoritePresets: [], presetHistory: [],
  autoCycleEnabled: false, autoCycleIntervalSec: 30, autoCycleMode: 'random',
  setCurrentPreset: (name: string) => { selected.push(name); set({ currentPresetName: name }) },
  toggleFavorite: (name: string) => set((state: any) => ({ favoritePresets: state.favoritePresets.includes(name) ? [] : [name] })),
  setPresetBrowserOpen: (open: boolean) => set({ presetBrowserOpen: open }),
  setAutoCycleEnabled() {}, setAutoCycleIntervalSec() {}, setAutoCycleMode() {},
}))
mock.module('../../src/stores/visualizerStore', () => ({ useVisualizerStore: store }))
mock.module('../../src/lib/milkdropPresets', () => ({ getAllNames: () => ['First preset', 'Second preset'] }))
const { default: Browser } = await import('../../src/components/MilkdropPresetBrowser')
const { createRoot } = await import('react-dom/client')
function View() { return store(state => state.presetBrowserOpen) ? <Browser /> : null }
const root = createRoot(document.getElementById('root')!)
await act(() => root.render(<View />))
assert.equal(document.querySelector('button button'), null, 'Preset rows must not contain nested buttons')
await act(() => document.querySelector<HTMLButtonElement>('[aria-label="Favorite Second preset"]')!.click())
assert.deepEqual(store.getState().favoritePresets, ['Second preset'])
assert.deepEqual(selected, [], 'Favoriting a preset must not also select it')
const select = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Second preset')!
await act(() => select.click())
assert.deepEqual(selected, ['Second preset'])
assert.equal(select.getAttribute('aria-pressed'), 'true')
await act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close Presets"]')!.click())
assert.equal(document.querySelector('input'), null)
await act(() => root.unmount())
