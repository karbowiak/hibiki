import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

const dom = new JSDOM("<div id='root'></div><div id='area'></div>", {
  url: "https://hibiki.example.test",
})
const previous = {
  window: globalThis.window,
  document: globalThis.document,
  customEvent: globalThis.CustomEvent,
  storage: globalThis.localStorage,
  act: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
}
globalThis.window = dom.window as unknown as Window & typeof globalThis
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
globalThis.CustomEvent = dom.window.CustomEvent as typeof CustomEvent
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { useGlobalHotkeys } = await import("../src/hooks/useGlobalHotkeys")
const { usePlayerStore } = await import("../src/stores/playerStore")
const { useRadioStreamStore } = await import("../src/stores/radioStreamStore")
const { useVisualizerStore } = await import("../src/stores/visualizerStore")
const { useVisualizerHotkeys } =
  await import("../src/hooks/useVisualizerHotkeys")
const originals = {
  player: usePlayerStore.getState(),
  radio: useRadioStreamStore.getState(),
  visualizer: useVisualizerStore.getState(),
}
let root: Root
let mounted = false
let calls: string[]
let seeks: number[]
function Harness() {
  const { hotkeyHelpOpen } = useGlobalHotkeys()
  useVisualizerHotkeys(() => calls.push("native-fullscreen"))
  return <output>{hotkeyHelpOpen ? "help" : "closed"}</output>
}
beforeEach(async () => {
  calls = []
  seeks = []
  usePlayerStore.setState({
    ...originals.player,
    currentTrack: { id: "1", duration: 10000 } as any,
    isPlaying: true,
    isInternetRadioActive: false,
    positionMs: 4000,
    volume: 0,
    lastAudibleVolume: 37,
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    next: () => calls.push("next"),
    prev: () => calls.push("previous"),
    seekTo: (value) => seeks.push(value),
    setVolume: (value) => calls.push(`volume:${value}`),
    toggleMute: () => calls.push("mute"),
    toggleShuffle: () => calls.push("shuffle"),
    cycleRepeat: () => calls.push("repeat"),
  })
  useRadioStreamStore.setState({
    ...originals.radio,
    currentStation: { uuid: "station" } as any,
    isStreamPlaying: true,
    isStreamBuffering: false,
    pauseStream: () => calls.push("radio-pause"),
    resumeStream: () => calls.push("radio-resume"),
  })
  useVisualizerStore.setState({
    ...originals.visualizer,
    fullscreenOpen: false,
    fullscreenMode: "spectrum",
    openFullscreen: () => calls.push("visualizer"),
    closeFullscreen: () => calls.push("close-visualizer"),
  })
  document.getElementById("area")!.replaceChildren()
  root = createRoot(document.getElementById("root")!)
  mounted = true
  await act(async () => root.render(<Harness />))
})
afterEach(async () => {
  if (mounted) await act(async () => root.unmount())
})
afterAll(() => {
  usePlayerStore.setState(originals.player)
  useRadioStreamStore.setState(originals.radio)
  useVisualizerStore.setState(originals.visualizer)
  globalThis.window = previous.window
  globalThis.document = previous.document
  globalThis.CustomEvent = previous.customEvent
  globalThis.localStorage = previous.storage
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act
  dom.window.close()
})
async function key(
  key: string,
  target: EventTarget = document.body,
  options: KeyboardEventInit = {},
  handled = false
) {
  const event = new dom.window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    composed: true,
    cancelable: true,
    ...options,
  })
  if (handled) event.preventDefault()
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

test("keyboard mute uses the same remembered-volume action as the UI", async () => {
  await key("m")
  expect(calls).toEqual(["mute"])
})
test("Space pauses and resumes the selected internet station without a Plex track", async () => {
  usePlayerStore.setState({ currentTrack: null, isInternetRadioActive: true })
  await key(" ")
  useRadioStreamStore.setState({
    isStreamPlaying: false,
    isStreamBuffering: false,
  })
  await key(" ")
  expect(calls).toEqual(["radio-pause", "radio-resume"])
})
test("handled keys and composition events cannot trigger playback commands", async () => {
  await key(" ", document.body, {}, true)
  await key("n", document.body, { isComposing: true })
  await key("m", document.body, { keyCode: 229 } as KeyboardEventInit)
  expect(calls).toEqual([])
})
test("focused buttons, links, ARIA widgets and editing descendants retain their keys", async () => {
  for (const html of [
    "<button><span>button</span></button>",
    '<a href="#"><span>link</span></a>',
    '<div role="slider"><span>slider</span></div>',
    '<div role="combobox"><span>choice</span></div>',
    '<div contenteditable="true"><span>editing</span></div>',
    "<input>",
    "<textarea>",
    "<select>",
  ]) {
    const area = document.getElementById("area")!
    area.innerHTML = html
    const target = area.querySelector("span") ?? area.firstElementChild!
    await key(" ", target)
    await key("ArrowUp", target)
  }
  expect(calls).toEqual([])
})
test("editing inside a shadow root cannot accidentally reach media shortcuts", async () => {
  const host = document.createElement("div")
  document.getElementById("area")!.append(host)
  const shadow = host.attachShadow({ mode: "open" })
  const input = document.createElement("input")
  shadow.append(input)
  await key("m", input)
  expect(calls).toEqual([])
})
test("holding a toggle key acts once while seek and volume keys may repeat", async () => {
  await key(" ")
  await key(" ", document.body, { repeat: true })
  await key("m", document.body, { repeat: true })
  await key("ArrowUp", document.body, { repeat: true })
  expect(calls).toEqual(["pause", "volume:5"])
})
test("seek shortcuts require a seekable selected source and clamp both directions", async () => {
  await key("ArrowLeft")
  await key("ArrowRight", document.body, { shiftKey: true })
  expect(seeks).toEqual([0, 10000])
  usePlayerStore.setState({ isInternetRadioActive: true })
  await key("ArrowRight")
  usePlayerStore.setState({ currentTrack: null, isInternetRadioActive: false })
  await key("ArrowLeft")
  expect(seeks).toEqual([0, 10000])
})
test("search commands work from text inputs and an unsupported modifier chord is untouched", async () => {
  const input = document.createElement("input")
  document.getElementById("area")!.append(input)
  let searches = 0
  const handler = () => {
    searches++
  }
  window.addEventListener("plexify:search-focus", handler)
  try {
    expect((await key("F", input, { metaKey: true })).defaultPrevented).toBe(
      true
    )
    expect((await key("k", input, { ctrlKey: true })).defaultPrevented).toBe(
      true
    )
    expect(
      (await key("f", input, { ctrlKey: true, altKey: true })).defaultPrevented
    ).toBe(false)
    expect(searches).toBe(2)
  } finally {
    window.removeEventListener("plexify:search-focus", handler)
  }
})
test("unmounting retires the global keyboard listener", async () => {
  await act(async () => root.unmount())
  mounted = false
  await key("m")
  expect(calls).toEqual([])
})

test("unknown track duration permits forward seeking rather than resetting position", async () => {
  usePlayerStore.setState({ currentTrack: { id: "1", duration: 0 } as any })
  await key("ArrowRight")
  expect(seeks).toEqual([9000])
})

test("MilkDrop preset shortcuts cannot also seek, skip or change repeat mode", async () => {
  useVisualizerStore.setState({
    fullscreenOpen: true,
    fullscreenMode: "milkdrop",
    currentPresetName: "Old",
    getNextPresetName: (direction) => {
      calls.push(`preset:${direction}`)
      return "Next"
    },
    getRandomPresetName: () => {
      calls.push("random")
      return "Random"
    },
    setCurrentPreset: (name) => calls.push(`selected:${name}`),
    setPresetBrowserOpen: (open) => calls.push(`browser:${open}`),
    toggleFavorite: (name) => calls.push(`favorite:${name}`),
  })
  await key("ArrowLeft")
  await key("ArrowRight")
  await key("r")
  await key("b")
  await key("f")
  expect(seeks).toEqual([])
  expect(calls).toEqual([
    "preset:-1",
    "selected:Next",
    "preset:1",
    "selected:Next",
    "random",
    "selected:Random",
    "browser:true",
    "favorite:Old",
  ])
})

test("visualizer shortcuts retain input editing and modifier chords", async () => {
  useVisualizerStore.setState({
    fullscreenOpen: true,
    fullscreenMode: "milkdrop",
    setCurrentPreset: () => calls.push("preset"),
    setFullscreenMode: () => calls.push("mode"),
  })
  const input = document.createElement("textarea")
  document.getElementById("area")!.append(input)
  await key("r", input)
  await key("1", input)
  await key("r", document.body, { ctrlKey: true })
  expect(calls).toEqual([])
})

test("Escape closes a preset browser first and a repeated Escape cannot close the visualizer", async () => {
  useVisualizerStore.setState({
    fullscreenOpen: true,
    fullscreenMode: "milkdrop",
    presetBrowserOpen: true,
    setPresetBrowserOpen: (open) => {
      calls.push(`browser:${open}`)
      useVisualizerStore.setState({ presetBrowserOpen: open })
    },
  })
  await key("Escape")
  await key("Escape", document.body, { repeat: true })
  expect(calls).toEqual(["browser:false"])
  await key("Escape")
  expect(calls).toEqual(["browser:false", "close-visualizer"])
})

test("search leaves the visualizer before focusing the main search field", async () => {
  useVisualizerStore.setState({ fullscreenOpen: true })
  const handler = () => calls.push("search")
  window.addEventListener("plexify:search-focus", handler)
  try {
    await key("k", document.body, { ctrlKey: true })
    expect(calls).toEqual(["close-visualizer", "search"])
  } finally {
    window.removeEventListener("plexify:search-focus", handler)
  }
})
