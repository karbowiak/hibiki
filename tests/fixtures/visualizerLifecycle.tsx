import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { Router } from "wouter"

const scenario = process.argv[2]
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test" })
globalThis.window = dom.window as any
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
globalThis.getComputedStyle = dom.window.getComputedStyle
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia = (() => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
})) as any
let hidden = false
Object.defineProperty(document, "hidden", { get: () => hidden })
const frames = new Map<number, FrameRequestCallback>()
const timers = new Map<number, () => void>()
let timerId = 0
globalThis.setInterval = ((callback: () => void) => {
  timers.set(++timerId, callback)
  return timerId
}) as any
globalThis.clearInterval = ((id: number) => {
  timers.delete(id)
}) as any
let frameId = 0
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++frameId, callback)
  return frameId
}
globalThis.cancelAnimationFrame = (id) => {
  frames.delete(id)
}
function step() {
  for (const [id, callback] of [...frames]) {
    frames.delete(id)
    callback(1000)
  }
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((done) => setImmediate(done))
let draws = 0,
  pcmReads = 0,
  fftReads = 0,
  renders = 0,
  presets = 0
const gradient = { addColorStop() {} }
const canvas = new Proxy(
  {
    clearRect: () => {
      draws++
    },
    createLinearGradient: () => gradient,
  },
  {
    get: (target, key) => (target as any)[key] ?? (() => {}),
  }
)
dom.window.HTMLCanvasElement.prototype.getContext = (() => canvas) as any
const core = await import("@tauri-apps/api/core")
mock.module("@tauri-apps/api/core", () => ({
  ...core,
  isTauri: () => scenario === "native",
  invoke: async () => undefined,
}))
mock.module("idb-keyval", () => ({
  createStore: () => () => Promise.resolve(),
  get: async () => undefined,
  set: async () => {},
  update: async () => {},
  del: async () => {},
}))
mock.module("../../src/components/MilkdropPresetBrowser", () => ({
  default: () => null,
}))
mock.module("../../src/components/shared/ArtworkImage", () => ({
  ArtworkImage: () => null,
}))
const meta = deferred<string[]>(),
  packs = deferred()
mock.module("../../src/lib/milkdropPresets", () => ({
  initPresetMeta: () =>
    scenario === "cancel-meta" ? meta.promise : Promise.resolve(["Preset"]),
  loadAllPacks: () =>
    scenario === "cancel-packs" ? packs.promise : Promise.resolve(),
  getPreset: () => ({}),
  getAllNames: () => ["Preset"],
}))
mock.module("butterchurn", () => ({
  default: {
    createVisualizer: () => ({
      connectAudio() {},
      render: () => {
        renders++
      },
      loadPreset: () => {
        presets++
      },
    }),
  },
}))
class AudioContextMock {
  static instances: AudioContextMock[] = []
  state = "running"
  closes = 0
  destination = {}
  node = {
    onaudioprocess: null as any,
    disconnects: 0,
    connect() {},
    disconnect() {
      this.disconnects++
    },
  }
  gain = {
    gain: { value: 1 },
    disconnects: 0,
    connect() {},
    disconnect() {
      this.disconnects++
    },
  }
  constructor() {
    AudioContextMock.instances.push(this)
  }
  createScriptProcessor() {
    return this.node
  }
  createGain() {
    return this.gain
  }
  async suspend() {
    this.state = "suspended"
  }
  async resume() {
    this.state = "running"
  }
  async close() {
    this.closes++
    this.state = "closed"
  }
}
globalThis.AudioContext = AudioContextMock as any
const minimizeQueries: ReturnType<typeof deferred<boolean>>[] = []
const nativeCallbacks: (() => void)[] = []
let nativeUnlistens = 0
mock.module("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMinimized() {
      const query = deferred<boolean>()
      minimizeQueries.push(query)
      return query.promise
    },
    async onResized(callback: () => void) {
      nativeCallbacks.push(callback)
      return () => {
        nativeUnlistens++
      }
    },
    async onFocusChanged(callback: () => void) {
      nativeCallbacks.push(callback)
      return () => {
        nativeUnlistens++
      }
    },
  }),
}))

const { usePlayerStore } = await import("../../src/stores/playerStore")
const { useVisualizerStore } = await import("../../src/stores/visualizerStore")
const { useEasterEggStore } = await import("../../src/stores/easterEggStore")
usePlayerStore.setState({ isPlaying: true })
useVisualizerStore.setState({
  fullscreenMode: "milkdrop",
  fullscreenOpen: true,
  autoCycleEnabled: false,
  getRecentSamples: (n) => {
    pcmReads++
    return new Float32Array(n)
  },
  getFrequencyData: () => {
    fftReads++
    return new Float32Array(1025).fill(-30)
  },
})
const { default: Fullscreen } =
  await import("../../src/components/VisualizerFullscreen")
const { default: Compact } =
  await import("../../src/components/VisualizerCanvas")
const { useVisualizationVisibility } =
  await import("../../src/hooks/useVisualizationVisibility")
const { useEasterEggs } = await import("../../src/hooks/useEasterEggs")
const root = createRoot(document.getElementById("root")!)
const render = async (element: any) => {
  await act(async () => {
    root.render(element)
    await tick()
  })
}
const visibility = async (value: boolean) => {
  await act(() => {
    hidden = value
    document.dispatchEvent(new dom.window.Event("visibilitychange"))
  })
}
const playing = async (value: boolean) => {
  await act(() => usePlayerStore.setState({ isPlaying: value }))
}

if (scenario === "compact") {
  const view = (mode: any, hoverPct: number | null = null) => (
    <Compact mode={mode} levels={null} progressPct={20} hoverPct={hoverPct} />
  )
  await render(view("waveform"))
  assert.equal(frames.size, 0, "Static waveform must not schedule RAF")
  const initialDraws = draws
  await render(view("waveform", 50))
  assert.ok(draws > initialDraws, "Static waveform must repaint hover changes")
  await render(view("spectrum"))
  assert.ok(frames.size > 0)
  step()
  step()
  assert.ok(fftReads > 0)
  assert.equal(
    pcmReads,
    0,
    "Spectrum must consume native FFT rather than duplicate PCM DFT"
  )
  await playing(false)
  const pausedReads = fftReads
  step()
  step()
  assert.equal(frames.size, 0)
  assert.equal(fftReads, pausedReads)
  await playing(true)
  await visibility(true)
  const hiddenReads = fftReads
  step()
  assert.equal(frames.size, 0)
  assert.equal(fftReads, hiddenReads)
  await visibility(false)
  assert.ok(frames.size > 0)
  const stale = [...frames.values()]
  await act(() => root.unmount())
  const unmountedDraws = draws
  stale.forEach((callback) => callback(1000))
  assert.equal(frames.size, 0)
  assert.equal(draws, unmountedDraws)
} else if (scenario === "bridge") {
  const { Player } = await import("../../src/components/Player")
  const { engine } = await import("../../src/audio/RustAudioEngine")
  const { useDeviceStore } = await import("../../src/stores/deviceStore")
  const { useEqStore } = await import("../../src/stores/eqStore")
  const { useAudioSettingsStore } =
    await import("../../src/stores/audioSettingsStore")
  useDeviceStore.setState({ initDeviceTracking: () => {}, dispose: () => {} })
  useEqStore.setState({ syncToEngine: () => {} })
  useAudioSettingsStore.setState({ syncToEngine: async () => {} })
  usePlayerStore.setState({ initAudioEvents: async () => () => {} })
  useVisualizerStore.setState({
    fullscreenOpen: false,
    compactMode: "spectrum",
  })
  const enabled: boolean[] = []
  engine.setVisualizerEnabled = (value) => {
    enabled.push(value)
  }
  await render(
    <Router hook={() => ["/", () => {}]}>
      <Player />
    </Router>
  )
  assert.equal(enabled.at(-1), true)
  await playing(false)
  assert.equal(enabled.at(-1), false)
  await playing(true)
  assert.equal(enabled.at(-1), true)
  await visibility(true)
  assert.equal(enabled.at(-1), false)
  await visibility(false)
  assert.equal(enabled.at(-1), true)
  await act(() => useVisualizerStore.setState({ compactMode: "waveform" }))
  assert.equal(enabled.at(-1), false)
  await act(() => useEasterEggStore.setState({ partyMode: true }))
  assert.equal(enabled.at(-1), true)
  await act(() => root.unmount())
  assert.equal(enabled.at(-1), false)
} else if (scenario === "milkdrop") {
  useVisualizerStore.setState({ autoCycleEnabled: true })
  await render(<Fullscreen />)
  assert.equal(AudioContextMock.instances.length, 1)
  const context = AudioContextMock.instances[0]
  step()
  assert.ok(renders > 0)
  assert.equal(timers.size, 1)
  await playing(false)
  assert.equal(context.state, "suspended")
  const pausedRenders = renders
  step()
  step()
  assert.equal(renders, pausedRenders)
  assert.equal(frames.size, 0)
  assert.equal(timers.size, 0)
  await playing(true)
  assert.equal(context.state, "running")
  assert.equal(timers.size, 1)
  await visibility(true)
  assert.equal(context.state, "suspended")
  assert.equal(frames.size, 0)
  assert.equal(timers.size, 0)
  await visibility(false)
  assert.equal(context.state, "running")
  const staleAudioCallback = context.node.onaudioprocess
  await render(null)
  assert.equal(context.closes, 1)
  assert.equal(context.node.disconnects, 1)
  assert.equal(context.gain.disconnects, 1)
  assert.equal(context.node.onaudioprocess, null)
  assert.equal(frames.size, 0)
  const beforeReads = pcmReads
  staleAudioCallback({})
  assert.equal(pcmReads, beforeReads)
  await render(<Fullscreen />)
  assert.equal(AudioContextMock.instances.length, 2)
  await act(() => root.unmount())
  assert.equal(AudioContextMock.instances[1].closes, 1)
  assert.equal(context.closes, 1)
  assert.equal(timers.size, 0)
} else if (scenario === "cancel-meta" || scenario === "cancel-packs") {
  await render(<Fullscreen />)
  const before = presets
  await act(() => root.unmount())
  await act(async () => {
    meta.resolve(["Preset"])
    packs.resolve()
    await tick()
  })
  assert.equal(presets, before, "Canceled loading cannot publish a preset")
  if (scenario === "cancel-meta")
    assert.equal(AudioContextMock.instances.length, 0)
  else {
    assert.equal(AudioContextMock.instances.length, 1)
    assert.equal(AudioContextMock.instances[0].closes, 1)
    assert.equal(AudioContextMock.instances[0].node.disconnects, 1)
  }
  assert.equal(frames.size, 0)
} else if (scenario === "native") {
  let visible = false
  function Probe() {
    visible = useVisualizationVisibility()
    return null
  }
  await render(<Probe />)
  assert.equal(minimizeQueries.length, 1)
  await act(async () => {
    minimizeQueries[0].resolve(false)
    await tick()
  })
  assert.equal(visible, true)
  await act(() => {
    nativeCallbacks[0]()
    nativeCallbacks[1]()
  })
  await act(async () => {
    minimizeQueries[2].resolve(true)
    await tick()
  })
  assert.equal(visible, false)
  await act(async () => {
    minimizeQueries[1].resolve(false)
    await tick()
  })
  assert.equal(
    visible,
    false,
    "An older visibility response must not undo minimization"
  )
  await act(() => nativeCallbacks[0]())
  await act(async () => {
    minimizeQueries[3].resolve(false)
    await tick()
  })
  assert.equal(visible, true)
  await act(() => root.unmount())
  assert.equal(nativeUnlistens, 2)
} else if (scenario === "party") {
  function Party() {
    useEasterEggs()
    return null
  }
  useEasterEggStore.setState({ partyMode: true, rainbow: false })
  await render(<Party />)
  step()
  assert.ok(pcmReads > 0)
  await playing(false)
  assert.equal(
    document.documentElement.style.getPropertyValue("--party-pulse"),
    "0"
  )
  assert.equal(document.documentElement.classList.contains("party-mode"), true)
  const pausedReads = pcmReads
  step()
  assert.equal(pcmReads, pausedReads)
  assert.equal(frames.size, 0)
  await playing(true)
  assert.ok(frames.size > 0)
  await visibility(true)
  assert.equal(frames.size, 0)
  await visibility(false)
  assert.ok(frames.size > 0)
  await act(() => root.unmount())
  assert.equal(frames.size, 0)
} else throw new Error(`Unknown scenario ${scenario}`)
