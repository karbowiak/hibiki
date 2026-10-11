import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"

const dom = new JSDOM("<div id='root'></div>", {
  url: "https://hibiki.example.test",
})
const previous = {
  document: globalThis.document,
  window: globalThis.window,
  storage: globalThis.localStorage,
  request: globalThis.requestAnimationFrame,
  cancel: globalThis.cancelAnimationFrame,
  act: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
}
globalThis.document = dom.window.document
globalThis.window = dom.window as unknown as Window & typeof globalThis
globalThis.localStorage = dom.window.localStorage
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// Other suites can initialize ReactDOM before a DOM exists, selecting its
// legacy input-event fallback. Supply its event hooks in this isolated DOM.
Object.assign(dom.window.HTMLInputElement.prototype, {
  attachEvent(this: HTMLInputElement, name: string, handler: EventListener) {
    this.addEventListener(name.slice(2), handler)
  },
  detachEvent(this: HTMLInputElement, name: string, handler: EventListener) {
    this.removeEventListener(name.slice(2), handler)
  },
})
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++frameId, callback)
  return frameId
}
globalThis.cancelAnimationFrame = (id) => {
  frames.delete(id)
}
const { default: VolumeSlider } =
  await import("../src/components/SquigglyVolumeSlider")
const { useEasterEggStore } = await import("../src/stores/easterEggStore")
const previousRainbow = useEasterEggStore.getState().rainbow
let root: Root
let changes: number[]

function Harness() {
  const [volume, setVolume] = useState(37)
  return (
    <VolumeSlider
      volume={volume}
      onChange={(value) => {
        changes.push(value)
        setVolume(value)
      }}
    />
  )
}
const input = () =>
  document.querySelector<HTMLInputElement>('input[type="range"]')!
async function press(key: string) {
  input().focus()
  const event = new dom.window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  })
  await act(() => {
    input().dispatchEvent(event)
  })
  return event
}

beforeEach(() => {
  changes = []
  useEasterEggStore.setState({ rainbow: false })
  root = createRoot(document.getElementById("root")!)
})
afterEach(async () => {
  await act(() => root.unmount())
  expect(frames.size).toBe(0)
})
afterAll(() => {
  useEasterEggStore.setState({ rainbow: previousRainbow })
  globalThis.document = previous.document
  globalThis.window = previous.window
  globalThis.localStorage = previous.storage
  globalThis.requestAnimationFrame = previous.request
  globalThis.cancelAnimationFrame = previous.cancel
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act
  dom.window.close()
})

test("volume is a labeled focusable native slider and keyboard changes reach playback", async () => {
  await act(() => root.render(<Harness />))
  expect(input().tabIndex).toBe(0)
  expect(input().getAttribute("aria-label")).toBe("Volume")
  expect(input().getAttribute("aria-valuetext")).toBe("37%")
  for (const [key, expected] of [
    ["ArrowRight", 38],
    ["ArrowUp", 39],
    ["ArrowLeft", 38],
    ["ArrowDown", 37],
    ["PageUp", 47],
    ["PageDown", 37],
    ["Home", 0],
    ["End", 100],
  ] as const) {
    expect((await press(key)).defaultPrevented).toBe(true)
    expect(input().valueAsNumber).toBe(expected)
    expect(input().getAttribute("aria-valuetext")).toBe(`${expected}%`)
    expect(changes.at(-1)).toBe(expected)
  }
  expect((await press("Tab")).defaultPrevented).toBe(false)
  await press("ArrowUp")
  expect(input().valueAsNumber).toBe(100)
  await press("Home")
  await press("ArrowDown")
  expect(input().valueAsNumber).toBe(0)
})

test("native range input changes update the squiggle and supplied volume callback", async () => {
  await act(() => root.render(<Harness />))
  await act(() => {
    input().value = "64"
    input().dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
  expect(changes).toEqual([64])
  expect(input().getAttribute("aria-valuetext")).toBe("64%")
  expect(document.querySelector("circle")?.getAttribute("cx")).toBe("80.24")
})

test("the volume animation is idle until changed and stops when its wave decays", async () => {
  await act(() => root.render(<Harness />))
  expect(frames.size).toBe(0)
  await press("PageUp")
  expect(frames.size).toBe(1)
  for (let count = 0; frames.size && count < 300; count++) {
    const callbacks = [...frames.values()]
    frames.clear()
    await act(() => {
      callbacks.forEach((callback) => callback(count * 16))
    })
  }
  expect(frames.size).toBe(0)
  expect(document.querySelector("circle")?.getAttribute("cy")).toBe("14")
  await press("ArrowLeft")
  expect(frames.size).toBe(1)
})

test("multiple rainbow sliders keep their SVG gradients separate", async () => {
  useEasterEggStore.setState({ rainbow: true })
  await act(() =>
    root.render(
      <>
        <VolumeSlider volume={20} onChange={() => {}} />
        <VolumeSlider volume={80} onChange={() => {}} />
      </>
    )
  )
  const gradients = [...document.querySelectorAll("linearGradient")]
  expect(gradients).toHaveLength(2)
  expect(gradients[0].id).not.toBe(gradients[1].id)
  const strokes = [...document.querySelectorAll("svg")].map((svg) =>
    svg.querySelectorAll("path")[1].getAttribute("stroke")
  )
  expect(strokes).toEqual(gradients.map((gradient) => `url(#${gradient.id})`))
})
