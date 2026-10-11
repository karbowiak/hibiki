import { ArtworkImage } from "../../../src/components/shared/ArtworkImage"
import {
  initPresetMeta,
  loadAllPacks,
  getPreset,
} from "../../../src/lib/milkdropPresets"
import { detectFocalPoint } from "../../../src/lib/focalPoint"
import { RadioAudioPlayer } from "../../../src/lib/radioAudio"
import { PlexWebSocketManager } from "../../../src/backends/plex/websocket"
import { createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { ImageModal } from "../../../src/components/shared/ImageModal"
import { ImageCacheControls } from "../../../src/components/ImageCacheControls"
import type { ImageCacheInfo } from "../../../src/lib/imageCache"
import "../../../src/styles.css"

const state = {
  ready: false,
  error: "",
  presetCount: 0,
  frames: 0,
  radioPlaying: false,
  radioPaused: false,
  radioError: "",
  artwork: false,
  focalPoint: false,
  ipc: false,
  plexWs: false,
  plexWss: false,
  violations: [] as string[],
}
const testWindow = window as any
testWindow.rendererCheck = state
let artworkRoot: Root | null = null
let cacheControlsRoot: Root | null = null
let cacheInfo: ImageCacheInfo
let cacheReply: {
  resolve: (info: ImageCacheInfo) => void
  reject: (error: Error) => void
} | null = null
testWindow.mountImageCacheControls = () => {
  cacheControlsRoot?.unmount()
  const host =
    document.getElementById("cache-controls-fixture") ??
    document.createElement("div")
  host.id = "cache-controls-fixture"
  Object.assign(host.style, {
    width: "640px",
    margin: "32px",
    padding: "24px",
    background: "#181818",
    borderRadius: "12px",
  })
  document.body.append(host)
  cacheInfo = {
    files: 2,
    bytes: 2048,
    max_bytes: 512 * 1024 * 1024,
    max_files: 4096,
  }
  testWindow.imageCacheClearCalls = 0
  cacheControlsRoot = createRoot(host)
  cacheControlsRoot.render(
    createElement(ImageCacheControls, {
      backend: {
        async getInfo() {
          return { ...cacheInfo }
        },
        clear() {
          testWindow.imageCacheClearCalls++
          return new Promise<ImageCacheInfo>((resolve, reject) => {
            cacheReply = { resolve, reject }
          })
        },
      },
    })
  )
}
testWindow.finishImageCacheClear = (fail = false) => {
  cacheInfo = { ...cacheInfo, files: fail ? 1 : 0, bytes: fail ? 1024 : 0 }
  if (fail)
    cacheReply!.reject(new Error("One artwork file could not be removed"))
  else cacheReply!.resolve({ ...cacheInfo })
}
testWindow.mountArtworkRetry = () => {
  const host = document.createElement("div")
  document.body.append(host)
  const retryRoot = createRoot(host)
  testWindow.unmountArtworkRetry = () => {
    retryRoot.unmount()
    host.remove()
  }
  testWindow.artworkRetry = { recovered: false, failed: false }
  retryRoot.render(
    createElement(
      "div",
      null,
      createElement(ArtworkImage, {
        src: "http://image.localhost/album/retry-fixture",
        loading: "eager",
        alt: "Retry cover",
        onLoad: () => {
          testWindow.artworkRetry.recovered = true
        },
      }),
      createElement(ArtworkImage, {
        src: "http://image.localhost/album/failure-fixture",
        loading: "eager",
        alt: "Failed cover",
        onFailure: () => {
          testWindow.artworkRetry.failed = true
        },
      })
    )
  )
}
testWindow.mountPlaylistCreator = async () => {
  const { CreatePlaylist } =
    await import("../../../src/components/Pages/CreatePlaylist")
  const { useLibraryStore } = await import("../../../src/stores/libraryStore")
  const original = useLibraryStore.getState().createPlaylist
  testWindow.playlistCreator = { fail: false, calls: 0, created: "" }
  useLibraryStore.setState({
    createPlaylist: async (title) => {
      testWindow.playlistCreator.calls++
      if (testWindow.playlistCreator.fail)
        throw new Error("Synthetic playlist failure")
      return { id: "fixture-playlist", title } as any
    },
  })
  const host = document.createElement("div")
  Object.assign(host.style, {
    transform: "translateZ(0)",
    overflow: "hidden",
    width: "260px",
    height: "90px",
  })
  document.body.append(host)
  const creatorRoot = createRoot(host)
  function Fixture() {
    const [open, setOpen] = useState(false)
    return createElement(
      "section",
      null,
      createElement(
        "button",
        {
          onClick: (event) => {
            event.currentTarget.focus({ preventScroll: true })
            setOpen(true)
          },
        },
        "Create fixture playlist"
      ),
      open
        ? createElement(CreatePlaylist, {
            onClose: () => setOpen(false),
            onCreated: (playlist) => {
              testWindow.playlistCreator.created = playlist.title
            },
          })
        : null
    )
  }
  creatorRoot.render(createElement(Fixture))
  testWindow.unmountPlaylistCreator = () => {
    creatorRoot.unmount()
    host.remove()
    useLibraryStore.setState({ createPlaylist: original })
  }
}

function ArtworkViewerFixture() {
  const [open, setOpen] = useState(false)
  return createElement(
    "section",
    {
      // Reproduce the stacking/containing context used by artwork in the player.
      style: {
        transform: "translateZ(0)",
        overflow: "hidden",
        width: 240,
        height: 120,
      },
    },
    createElement(
      "button",
      {
        onClick: (event) => {
          event.currentTarget.focus({ preventScroll: true })
          setOpen(true)
        },
      },
      "View fixture artwork"
    ),
    createElement("button", { onClick: () => {} }, "Background control"),
    open
      ? createElement(ImageModal, {
          src: "http://image.localhost/album/modal-fixture",
          alt: "Fixture album cover",
          onClose: () => setOpen(false),
        })
      : null
  )
}
testWindow.mountArtworkViewer = () => {
  const host = document.createElement("div")
  document.body.append(host)
  artworkRoot = createRoot(host)
  artworkRoot.render(createElement(ArtworkViewerFixture))
  const player = document.createElement("div")
  player.id = "fixture-player-overlay"
  Object.assign(player.style, {
    position: "fixed",
    bottom: "0",
    width: "100%",
    height: "100px",
    zIndex: "10000",
    background: "#282828",
    color: "white",
  })
  player.textContent = "Synthetic player overlay"
  document.body.append(player)
}
document.addEventListener("securitypolicyviolation", (event) => {
  state.violations.push(event.effectiveDirective)
})

testWindow.tryUntrustedContent = (scriptsOnly = false) => {
  const inline = document.createElement("script")
  inline.textContent = "window.inlineScriptRan = true"
  document.body.append(inline)
  const remote = document.createElement("script")
  remote.src = "http://untrusted.localhost/attack.js"
  document.body.append(remote)
  const img = document.createElement("img")
  img.setAttribute("onerror", "window.inlineHandlerRan = true")
  img.src = "/missing-image.png"
  document.body.append(img)
  if (scriptsOnly) return
  const frame = document.createElement("iframe")
  frame.src = "/untrusted-frame.html"
  document.body.append(frame)
  const object = document.createElement("object")
  object.data = "/untrusted-object.html"
  document.body.append(object)
  const base = document.createElement("base")
  base.href = "http://untrusted.localhost/"
  document.head.append(base)
  const form = document.createElement("form")
  form.action = "http://untrusted.localhost/submitted"
  document.body.append(form)
  form.submit()
}

let radio: RadioAudioPlayer | null = null
let context: AudioContext | null = null
const plexSockets: PlexWebSocketManager[] = []
testWindow.pauseRadio = () => radio?.pause()
testWindow.disposeRenderer = async () => {
  cacheControlsRoot?.unmount()
  artworkRoot?.unmount()
  for (const socket of plexSockets) socket.disconnect()
  radio?.stop()
  if (context && context.state !== "closed") await context.close()
}

document.getElementById("start")!.addEventListener("click", async () => {
  try {
    // Create/resume audio during a real user gesture. All fixture output is muted.
    context = new AudioContext()
    await context.resume()
    const audio = new Audio()
    radio = new RadioAudioPlayer(audio, context)
    radio.subscribe({
      onPlaying: () => {
        state.radioPlaying = true
      },
      onPause: () => {
        state.radioPaused = true
      },
      onError: (error) => {
        state.radioError = error
      },
    })
    radio.start(`${location.origin}/radio.wav`, 0)

    const source = context.createOscillator()
    const mute = context.createGain()
    mute.gain.value = 0
    source.connect(mute).connect(context.destination)
    source.start()
    const mod = (await import("butterchurn")) as any
    const butterchurn = mod.default?.default ?? mod.default
    const canvas = document.getElementById("milkdrop") as HTMLCanvasElement
    const visualizer = butterchurn.createVisualizer(context, canvas, {
      width: canvas.width,
      height: canvas.height,
      textureRatio: 1,
    })
    visualizer.connectAudio(source)
    const names = await initPresetMeta()
    await loadAllPacks()
    state.presetCount = names.length
    const preset = names.map(getPreset).find(Boolean)
    if (!preset) throw new Error("No bundled MilkDrop preset was loaded")
    visualizer.loadPreset(preset, 0)
    for (let frame = 0; frame < 5; frame++) {
      visualizer.render()
      state.frames++
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }

    const imageUrl = "http://image.localhost/artist/fixture"
    const image = new Image()
    image.src = imageUrl
    await image.decode()
    state.artwork = image.naturalWidth > 0
    const point = await detectFocalPoint(imageUrl)
    state.focalPoint = Number.isFinite(point.x) && Number.isFinite(point.y)
    state.ipc =
      (await fetch("http://ipc.localhost/probe").then((response) =>
        response.text()
      )) === "fixture IPC"
    const endpoints = await fetch("/renderer-fixture.json").then((response) =>
      response.json()
    )
    for (const [key, endpoint] of [
      ["plexWs", endpoints.ws],
      ["plexWss", endpoints.wss],
    ] as const) {
      const socket = new PlexWebSocketManager(
        () =>
          ({
            setWsConnected: (connected: boolean) => {
              state[key] = connected
            },
            setLibraryScanning: () => {},
          }) as any
      )
      plexSockets.push(socket)
      socket.connect(endpoint, "synthetic-renderer-token", 1)
    }
    state.ready = true
  } catch (error) {
    state.error = String(error)
  }
})
