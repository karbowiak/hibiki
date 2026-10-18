import React from "react"
import { createRoot } from "react-dom/client"
import EqPanel from "../../../src/components/EqPanel"
import { useEqStore } from "../../../src/stores/eqStore"
import { useDeviceStore } from "../../../src/stores/deviceStore"
import { setTheme } from "../../../src/stores/themeStore"
import { setFont } from "../../../src/stores/fontStore"
import "../../../src/styles.css"

const w = window as any,
  calls: { command: string; args: any }[] = []
let count = 0
const callbacks = new Map<number, (value: unknown) => void>()
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
w.__TAURI_INTERNALS__ = {
  metadata: {
    currentWindow: { label: "fixture" },
    currentWebview: { label: "fixture" },
  },
  transformCallback: (fn: (value: unknown) => void) => {
    callbacks.set(++count, fn)
    return count
  },
  unregisterCallback: () => {},
  invoke: async (command: string, args: any = {}) => {
    if (command.startsWith("client_storage_")) return w.fixtureClientStorage.invoke(command, args)
    calls.push({ command, args })
    if (command === "plugin:event|listen") return count
    if (command === "plugin:event|unlisten") return null
    if (command === "plugin:opener|open_url") return null
    if (command === "audio_configure_eq_scene") {
      if (args.outputKey !== useEqStore.getState().currentOutput?.key)
        throw Error("Output changed")
      return {
        tonePostgainDb: args.postgainDb ?? 0,
        correctionPreampDb: args.correction?.preampDb ?? 0,
        safetyDb: 0,
        effectivePostgainDb: 0,
        sampleRate: 48000,
      }
    }
    if (command === "audio_configure_eq") return args.postgainDb ?? 0
    if (command === "autoeq_search") {
      if (localStorage.getItem("fixture-offline"))
        throw Error(
          "AutoEq could not be reached. Try again or import a profile."
        )
      return {
        items: ["ANC On", "ANC Off"].map((mode, index) => ({
          id: `model-${index}`,
          name: `Fixture Headphone (${mode})`,
          measurement: "oratory1990",
          rig: "GRAS over-ear",
          target: null,
        })),
        total: 2,
        catalogueSize: 8850,
        revision: "a".repeat(40),
        stale: false,
      }
    }
    if (command === "autoeq_download") {
      if (args.sourceRevision !== "a".repeat(40))
        throw Error("Revision changed")
      return {
        name: `Fixture Headphone (${args.modelId === "model-0" ? "ANC On" : "ANC Off"})`,
        text: "Preamp: -6.1 dB\nFilter 1: ON PK Fc 1234 Hz Gain 4 dB Q 2.5\nFilter 2: ON LSC Fc 100 Hz Gain 2 dB Q 0.7",
        url: "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/pinned/results/fixture.txt",
        revision: "a".repeat(40),
        measurement: "oratory1990",
        rig: "GRAS over-ear",
        target: null,
        license:
          "MIT License\nCopyright (c) Jaakko Pasanen\nPermission is hereby granted…",
      }
    }
    throw Error(`Unsupported isolated IPC: ${command}`)
  },
}
const output = (id: string, key = id) => ({
  id,
  key,
  name: id === "1" ? "USB DAC" : "Speakers",
  stable: true,
  available: true,
})
// Native device discovery is asynchronous. Restore SQLite preferences before
// announcing this fixture's synchronous synthetic output.
await useEqStore.persist.rehydrate()
useDeviceStore.setState({
  currentDevice: "USB DAC",
  outputAvailable: true,
  currentOutput: output("1"),
  devices: [],
})
useEqStore.getState().setCurrentOutput(output("1"))
setTheme("dark")
setFont("inter")
w.fixtureCorrection = {
  calls: () => calls,
  state: () => useEqStore.getState(),
  output: (id: string, key: string) =>
    useEqStore.getState().setCurrentOutput(output(id, key)),
  theme: (value: "dark" | "light") => setTheme(value),
}
createRoot(document.getElementById("root")!).render(
  <main className="h-screen bg-(--bg-base) text-(--text-primary)">
    <div className="mx-auto h-full w-full max-w-[430px] overflow-y-auto bg-(--bg-sidebar)">
      <EqPanel onClose={() => {}} />
    </div>
  </main>
)
w.visualFixtureReady = true
