import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { deferred, settle } from "./helpers/radioAudioFakes"

const previousStorage = globalThis.localStorage
const storage = new Map<string, string>()
globalThis.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => storage.clear(), key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size },
} as Storage

const core = await import("@tauri-apps/api/core")
const events = await import("@tauri-apps/api/event")
const requests: { name: string; result: ReturnType<typeof deferred<unknown>> }[] = []
const registrations: { name: string; handler: (e: { payload: unknown }) => void; result: ReturnType<typeof deferred<() => void>> }[] = []
mock.module("@tauri-apps/api/core", () => ({ ...core, invoke: (name: string) => {
  const result = deferred<unknown>(); requests.push({ name, result }); return result.promise
} }))
mock.module("@tauri-apps/api/event", () => ({ ...events, listen: (name: string, handler: (e: { payload: unknown }) => void) => {
  const result = deferred<() => void>(); registrations.push({ name, handler, result }); return result.promise
} }))
const { useDeviceStore } = await import("../src/stores/deviceStore")
const { useEqStore } = await import("../src/stores/eqStore")
const originalApply = useEqStore.getState().setCurrentDevice
const applyProfile = mock((name: string) => useEqStore.setState({ currentDevice: name }))
useEqStore.setState({ setCurrentDevice: applyProfile })
const state = () => useDeviceStore.getState()

function resolveRefresh(index: number, name: string, available: boolean) {
  const group = requests.slice(index * 3, index * 3 + 3)
  expect(group.map(request => request.name)).toEqual(["get_audio_output_devices", "get_audio_output_device", "audio_get_output_available"])
  group[0].result.resolve([{ name, is_default: true }]); group[1].result.resolve(name); group[2].result.resolve(available)
}
afterEach(() => {
  state().dispose()
  useDeviceStore.setState({ devices: [], currentDevice: "", outputAvailable: true })
  useEqStore.setState({ currentDevice: "" })
  applyProfile.mockClear()
  requests.splice(0); registrations.splice(0)
})
afterAll(() => {
  useEqStore.setState({ setCurrentDevice: originalApply })
  globalThis.localStorage = previousStorage
  mock.restore()
})

test("repeated initialization registers once and disposal releases late listener registrations", async () => {
  state().initDeviceTracking(); state().initDeviceTracking()
  expect(registrations.map(registration => registration.name)).toEqual(["audio-device-changed", "audio-output-availability"])
  expect(requests).toHaveLength(3)
  state().dispose()
  const stop1 = mock(() => {}), stop2 = mock(() => {})
  registrations[0].result.resolve(stop1); registrations[1].result.resolve(stop2)
  registrations[0].handler({ payload: "Retired speakers" }); registrations[1].handler({ payload: false })
  resolveRefresh(0, "Retired speakers", false)
  await settle()
  expect(stop1).toHaveBeenCalledTimes(1); expect(stop2).toHaveBeenCalledTimes(1)
  expect(state().currentDevice).toBe("")
  expect(state().outputAvailable).toBe(true)
  expect(applyProfile).toHaveBeenCalledTimes(0)
})

test("a slower device query cannot overwrite a newer default device or EQ profile", async () => {
  state().initDeviceTracking()
  const refreshed = state().refreshDevices()
  resolveRefresh(1, "Headphones", false)
  await refreshed
  resolveRefresh(0, "Old speakers", true)
  await settle()
  expect(state().currentDevice).toBe("Headphones")
  expect(state().outputAvailable).toBe(false)
  expect(applyProfile.mock.calls.map(call => call[0])).toEqual(["Headphones"])
})

test("availability events fence stale enumeration and recovery refreshes the current device", async () => {
  state().initDeviceTracking()
  registrations[1].handler({ payload: false })
  resolveRefresh(0, "Old speakers", true)
  await settle()
  expect(state().outputAvailable).toBe(false)
  registrations[1].handler({ payload: true })
  resolveRefresh(1, "Recovered speakers", true)
  await settle()
  expect(state().outputAvailable).toBe(true)
  expect(state().currentDevice).toBe("Recovered speakers")
})

test("retired mount callbacks cannot change a new mount or leak listener handles", async () => {
  state().initDeviceTracking()
  const retired = registrations.slice()
  state().dispose(); state().initDeviceTracking()
  const cleanup = mock(() => {})
  retired[0].result.resolve(cleanup)
  retired[0].handler({ payload: "Retired" })
  retired[1].handler({ payload: false })
  resolveRefresh(1, "Current", true)
  await settle()
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(state().currentDevice).toBe("Current")
  expect(applyProfile.mock.calls.map(call => call[0])).toEqual(["Current"])
})
