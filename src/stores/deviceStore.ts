import { create } from "zustand"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { useEqStore } from "./eqStore"
import type { OutputIdentity } from "../audio/outputIdentity"

export interface AudioOutputDevice {
  id: string
  stable: boolean
  name: string
  is_default: boolean
}

interface DeviceState {
  devices: AudioOutputDevice[]
  currentDevice: string
  outputAvailable: boolean
  currentOutput: OutputIdentity | null
  initDeviceTracking: () => void
  refreshDevices: () => Promise<void>
  dispose: () => void
}

let unlisteners: UnlistenFn[] = []
let tracking = false
let generation = 0
let refreshRevision = 0

function applyDevice(output: OutputIdentity | null, devices: AudioOutputDevice[]) {
  const eq = useEqStore.getState()
  const sameName = output ? devices.filter(device => device.name === output.name) : []
  eq.setCurrentOutput(output, sameName.length === 1 && sameName[0].id === output?.id)
}

export const useDeviceStore = create<DeviceState>()((set, get) => ({
  devices: [],
  currentDevice: "",
  outputAvailable: true,
  currentOutput: null,

  initDeviceTracking: () => {
    if (tracking) return
    tracking = true
    const owner = ++generation
    const isCurrent = () => tracking && owner === generation
    const adopt = (fn: UnlistenFn) => { if (isCurrent()) unlisteners.push(fn); else fn() }

    void listen<string>("audio-device-changed", () => {
      if (!isCurrent()) return
      void get().refreshDevices()
    }).then(adopt).catch(() => {})

    void listen<boolean>("audio-output-availability", event => {
      if (!isCurrent()) return
      ++refreshRevision
      set({ outputAvailable: event.payload })
      const output = get().currentOutput
      if (!event.payload && output) {
        const unavailable = { ...output, available: false }
        set({ currentOutput: unavailable }); applyDevice(unavailable, get().devices)
      }
      if (event.payload) void get().refreshDevices()
    }).then(adopt).catch(() => {})

    void listen<OutputIdentity | null>("audio-output-identity", () => {
      if (isCurrent()) void get().refreshDevices()
    }).then(adopt).catch(() => {})

    void get().refreshDevices()
  },

  refreshDevices: async () => {
    const owner = generation
    const revision = ++refreshRevision
    try {
      const [devices, identity, outputAvailable] = await Promise.all([
        invoke<AudioOutputDevice[]>("get_audio_output_devices"),
        invoke<OutputIdentity | null>("audio_get_output_identity"),
        invoke<boolean>("audio_get_output_available"),
      ])
      if (owner !== generation || revision !== refreshRevision) return
      const currentOutput = identity ? { ...identity, available: identity.available && outputAvailable } : null
      set({ devices, currentDevice: identity?.name ?? "", outputAvailable, currentOutput })
      applyDevice(currentOutput, devices)
    } catch {
      // Keep the last known state when device enumeration temporarily fails.
    }
  },

  dispose: () => {
    tracking = false
    ++generation
    ++refreshRevision
    for (const fn of unlisteners) fn()
    unlisteners = []
  },
}))
