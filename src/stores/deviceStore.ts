import { create } from "zustand"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { useEqStore } from "./eqStore"

export interface AudioOutputDevice {
  name: string
  is_default: boolean
}

interface DeviceState {
  devices: AudioOutputDevice[]
  currentDevice: string
  outputAvailable: boolean
  initDeviceTracking: () => void
  refreshDevices: () => Promise<void>
  dispose: () => void
}

let unlisteners: UnlistenFn[] = []
let tracking = false
let generation = 0
let refreshRevision = 0

function applyDevice(name: string) {
  const eq = useEqStore.getState()
  if (eq.currentDevice !== name) eq.setCurrentDevice(name)
}

export const useDeviceStore = create<DeviceState>()((set, get) => ({
  devices: [],
  currentDevice: "",
  outputAvailable: true,

  initDeviceTracking: () => {
    if (tracking) return
    tracking = true
    const owner = ++generation
    const isCurrent = () => tracking && owner === generation
    const adopt = (fn: UnlistenFn) => { if (isCurrent()) unlisteners.push(fn); else fn() }

    void listen<string>("audio-device-changed", event => {
      if (!isCurrent()) return
      set({ currentDevice: event.payload })
      applyDevice(event.payload)
      void get().refreshDevices()
    }).then(adopt).catch(() => {})

    void listen<boolean>("audio-output-availability", event => {
      if (!isCurrent()) return
      ++refreshRevision
      set({ outputAvailable: event.payload })
      if (event.payload) void get().refreshDevices()
    }).then(adopt).catch(() => {})

    void get().refreshDevices()
  },

  refreshDevices: async () => {
    const owner = generation
    const revision = ++refreshRevision
    try {
      const [devices, currentDevice, outputAvailable] = await Promise.all([
        invoke<AudioOutputDevice[]>("get_audio_output_devices"),
        invoke<string>("get_audio_output_device"),
        invoke<boolean>("audio_get_output_available"),
      ])
      if (owner !== generation || revision !== refreshRevision) return
      set({ devices, currentDevice, outputAvailable })
      applyDevice(currentDevice)
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
