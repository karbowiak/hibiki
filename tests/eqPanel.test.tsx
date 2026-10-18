import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { engine } from "../src/audio/RustAudioEngine"
import { useEqStore } from "../src/stores/eqStore"
import EqPanel from "../src/components/EqPanel"

const dom = new JSDOM("<div id='root'></div>", {
  url: "https://hibiki.example.test",
})
const previous = {
  document: globalThis.document,
  window: globalThis.window,
  act: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
}
globalThis.document = dom.window.document
globalThis.window = dom.window as unknown as Window & typeof globalThis
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(dom.window.HTMLInputElement.prototype, {
  attachEvent(this: HTMLInputElement, name: string, handler: EventListener) {
    this.addEventListener(name.slice(2), handler)
  },
  detachEvent(this: HTMLInputElement, name: string, handler: EventListener) {
    this.removeEventListener(name.slice(2), handler)
  },
})
const initial = useEqStore.getState()
const originalConfigure = engine.configureEq
engine.configureEq = async (settings) => settings.postgainDb ?? -6
let root: Root
let mounted: boolean
const sliders = () => [
  ...document.querySelectorAll<HTMLDivElement>('[role="slider"]'),
]
const state = () => useEqStore.getState()

beforeEach(async () => {
  useEqStore.setState({
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    enabled: true,
    autoPostgain: true,
    postgainDb: 0,
    applying: false,
    eqError: null,
    currentDevice: "",
    deviceProfiles: {},
  })
  root = createRoot(document.getElementById("root")!)
  mounted = true
  await act(async () => root.render(<EqPanel onClose={() => {}} />))
})
afterEach(async () => {
  if (mounted) await act(async () => root.unmount())
})
afterAll(() => {
  engine.configureEq = originalConfigure
  useEqStore.setState(initial)
  globalThis.document = previous.document
  globalThis.window = previous.window
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act
  dom.window.close()
})

function pointer(
  target: HTMLElement,
  type: string,
  y: number,
  id = 1,
  button = 0
) {
  const event = new dom.window.MouseEvent(type, {
    clientY: y,
    button,
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperties(event, {
    pointerId: { value: id },
    isPrimary: { value: true },
  })
  target.dispatchEvent(event)
}
function prepareDrag(target = sliders()[0]) {
  let captured = false
  let released = 0
  target.getBoundingClientRect = () => ({
    top: 0,
    bottom: 200,
    height: 200,
    width: 32,
    left: 0,
    right: 32,
    x: 0,
    y: 0,
    toJSON() {},
  })
  target.setPointerCapture = () => {
    captured = true
  }
  target.hasPointerCapture = () => captured
  target.releasePointerCapture = () => {
    captured = false
    released++
  }
  return { target, releases: () => released }
}

test("EQ sliders expose vertical dB values and standard Home/End and arrow keys", async () => {
  const first = sliders()[0]
  expect(first.getAttribute("aria-orientation")).toBe("vertical")
  expect(first.getAttribute("aria-valuetext")).toBe("0 dB")
  expect(sliders()[5].getAttribute("aria-label")).toBe("1 kHz band")
  for (const [key, value] of [
    ["Home", -12],
    ["End", 12],
    ["ArrowLeft", 11],
    ["ArrowRight", 12],
    ["PageDown", 9],
    ["PageUp", 12],
  ] as const) {
    const event = new dom.window.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    })
    await act(async () => {
      first.dispatchEvent(event)
    })
    expect(state().gains[0]).toBe(value)
    expect(event.defaultPrevented).toBe(true)
  }
})

test("disabled EQ controls cannot mutate preferences through keyboard or native input", async () => {
  await act(async () =>
    useEqStore.setState({ enabled: false, autoPostgain: false })
  )
  for (const slider of sliders()) {
    expect(slider.tabIndex).toBe(-1)
    expect(slider.getAttribute("aria-disabled")).toBe("true")
  }
  const preset = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Bass Boost"
  )!
  expect(preset.disabled).toBe(true)
  const automatic = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Auto"
  )!
  expect(automatic.disabled).toBe(true)
  const gain = document.querySelector<HTMLInputElement>('input[type="range"]')!
  expect(gain.disabled).toBe(true)
  await act(async () => {
    preset.click()
    sliders()[0].dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "End",
        bubbles: true,
        cancelable: true,
      })
    )
    sliders()[0].dispatchEvent(
      new dom.window.WheelEvent("wheel", {
        deltaY: -1,
        bubbles: true,
        cancelable: true,
      })
    )
    gain.value = "8"
    gain.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
  expect(state().gains).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  expect(state().postgainDb).toBe(0)
})

test("cancelled drags release capture and cannot keep changing a band", async () => {
  const { target, releases } = prepareDrag()
  await act(async () => {
    pointer(target, "pointerdown", 50)
  })
  expect(state().gains[0]).toBe(6)
  await act(async () => {
    pointer(target, "pointercancel", 50)
    pointer(target, "pointermove", 150)
  })
  expect(state().gains[0]).toBe(6)
  expect(releases()).toBe(1)
})

test("disabling EQ and unmounting the panel retire their captured drag listeners", async () => {
  const { target } = prepareDrag()
  await act(async () => {
    pointer(target, "pointerdown", 50)
  })
  await act(async () => useEqStore.setState({ enabled: false }))
  await act(async () => {
    pointer(target, "pointermove", 150)
  })
  expect(state().gains[0]).toBe(6)
  await act(async () => useEqStore.setState({ enabled: true }))
  await act(async () => {
    pointer(target, "pointerdown", 100)
  })
  await act(async () => root.unmount())
  mounted = false
  pointer(target, "pointermove", 150)
  expect(state().gains[0]).toBe(0)
})

test("a different pointer and a secondary mouse button cannot move the active band", async () => {
  const { target } = prepareDrag()
  await act(async () => {
    pointer(target, "pointerdown", 50, 1, 2)
  })
  expect(state().gains[0]).toBe(0)
  await act(async () => {
    pointer(target, "pointerdown", 50)
    pointer(target, "pointermove", 150, 2)
  })
  expect(state().gains[0]).toBe(6)
})

test("rapid wheel changes read the current band value and stop page scrolling", async () => {
  const target = sliders()[0]
  const events = [1, 2].map(
    () =>
      new dom.window.WheelEvent("wheel", {
        deltaY: -1,
        bubbles: true,
        cancelable: true,
      })
  )
  await act(async () => {
    events.forEach((event) => target.dispatchEvent(event))
  })
  expect(state().gains[0]).toBe(2)
  expect(events.every((event) => event.defaultPrevented)).toBe(true)
})

test("a replacement drag retires the previous band and normal pointerup ends the new drag", async () => {
  const first = prepareDrag(sliders()[0]),
    next = prepareDrag(sliders()[1])
  await act(async () => {
    pointer(first.target, "pointerdown", 50)
  })
  await act(async () => {
    pointer(next.target, "pointerdown", 100, 2)
    pointer(first.target, "pointermove", 150)
    pointer(next.target, "pointermove", 50, 2)
    pointer(next.target, "pointerup", 50, 2)
    pointer(next.target, "pointermove", 150, 2)
  })
  expect(state().gains.slice(0, 2)).toEqual([6, 6])
  expect(first.releases()).toBe(1)
  expect(next.releases()).toBe(1)
})

test("lost capture ends a drag and pinch zoom does not modify the EQ", async () => {
  const { target } = prepareDrag()
  await act(async () => {
    pointer(target, "pointerdown", 50)
    pointer(target, "lostpointercapture", 50)
    pointer(target, "pointermove", 150)
  })
  expect(state().gains[0]).toBe(6)
  const zoom = new dom.window.WheelEvent("wheel", {
    deltaY: -1,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  await act(async () => {
    target.dispatchEvent(zoom)
  })
  expect(zoom.defaultPrevented).toBe(false)
  expect(state().gains[0]).toBe(6)
})

test("manual postgain has a stable name and exposes native range changes in dB", async () => {
  await act(async () =>
    useEqStore.setState({ autoPostgain: false, postgainDb: 2.5 })
  )
  const gain = document.querySelector<HTMLInputElement>('input[type="range"]')!
  expect(gain.getAttribute("aria-label")).toBe("Postgain")
  expect(gain.getAttribute("aria-valuetext")).toBe("+2.5 dB")
  expect(gain.parentElement?.className).toContain("focus-within:ring-2")
  await act(async () => {
    gain.value = "3"
    gain.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
  expect(state().postgainDb).toBe(3)
  expect(gain.getAttribute("aria-valuetext")).toBe("+3 dB")
  expect(gain.getAttribute("aria-label")).toBe("Postgain")
})

test("choosing a preset resets gain to zero with Auto off and keeps gain controls available", async () => {
  await act(async () => state().setPostgainDb(-7))
  const buttons = () => [...document.querySelectorAll("button")]
  await act(async () => buttons().find(button => button.textContent === "Bass Boost")!.click())
  const automatic = buttons().find(button => button.textContent === "Auto")!
  expect(automatic.getAttribute("aria-pressed")).toBe("false")
  expect(state().postgainDb).toBe(0)
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Postgain"]')!.value).toBe("0")
  await act(async () => automatic.click())
  expect(state().autoPostgain).toBe(true)
  expect(document.querySelector('input[aria-label="Postgain"]')).toBeNull()
  await act(async () => automatic.click())
  expect(state().autoPostgain).toBe(false)
  expect(state().postgainDb).toBe(0)
  const gain = document.querySelector<HTMLInputElement>('input[aria-label="Postgain"]')!
  await act(async () => {
    gain.value = "2"
    gain.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
  expect(state().postgainDb).toBe(2)
})
