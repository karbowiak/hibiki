import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { engine, type EqConfiguration } from "../src/audio/RustAudioEngine"
import { useEqStore, type EqGains, type EqProfile } from "../src/stores/eqStore"
import { deferred, settle } from "./helpers/radioAudioFakes"

const original = engine.configureEq
const snapshot = useEqStore.getState()
const requests: {
  settings: EqConfiguration
  result: ReturnType<typeof deferred<number>>
}[] = []
const state = () => useEqStore.getState()
const bass: EqGains = [8, 6, 4, 2, 0, 0, 0, 0, 0, 0]
const profile = (gains: EqGains, manual = false): EqProfile => ({
  gains,
  enabled: true,
  autoPostgain: !manual,
  postgainDb: manual ? 2.5 : 8,
})
engine.configureEq = (settings) => {
  const result = deferred<number>()
  requests.push({
    settings: { ...settings, gainsDb: [...settings.gainsDb] },
    result,
  })
  return result.promise
}
beforeEach(() => {
  useEqStore.setState({
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    enabled: true,
    postgainDb: 0,
    autoPostgain: true,
    applying: false,
    eqError: null,
    currentDevice: "",
    deviceProfiles: {},
    clearedDeviceProfiles: [],
  })
})
afterEach(async () => {
  for (const request of requests) request.result.resolve(-9.75)
  await settle()
  requests.length = 0
})
afterAll(() => {
  engine.configureEq = original
  useEqStore.setState(snapshot)
})

test("gain compensation defaults off and presets clear earlier level adjustments", () => {
  expect(useEqStore.getInitialState().autoPostgain).toBe(false)
  expect(useEqStore.getInitialState().postgainDb).toBe(0)
  for (const autoPostgain of [true, false]) {
    useEqStore.setState({ autoPostgain, postgainDb: -8 })
    state().applyPreset(bass)
    expect(state().gains).toEqual(bass)
    expect(state().autoPostgain).toBe(false)
    expect(state().postgainDb).toBe(0)
    expect(requests.at(-1)!.settings.postgainDb).toBe(0)
  }
})

test("automatic and manual gain remain opt-in after choosing a preset", () => {
  state().applyPreset(bass)
  state().setAutoPostgain(true)
  expect(requests.at(-1)!.settings.postgainDb).toBeNull()
  state().setAutoPostgain(false)
  expect(requests.at(-1)!.settings.postgainDb).toBe(0)
  state().setPostgainDb(2.5)
  state().setBand(1, 5)
  expect(state().autoPostgain).toBe(false)
  expect(requests.at(-1)!.settings.postgainDb).toBe(2.5)
})

test("a pending automatic response cannot restore attenuation after choosing a preset", async () => {
  state().syncToEngine()
  state().applyPreset(bass)
  requests[0].result.resolve(-9.75)
  await settle()
  expect(state().autoPostgain).toBe(false)
  expect(state().postgainDb).toBe(0)
  expect(state().applying).toBe(true)
  requests[1].result.resolve(0)
  await settle()
  expect(state().postgainDb).toBe(0)
  expect(state().applying).toBe(false)
})

test("saved automatic gain is recomputed natively with the complete EQ settings", async () => {
  useEqStore.setState({ gains: bass, postgainDb: 8 })
  state().syncToEngine()
  expect(requests).toHaveLength(1)
  expect(requests[0].settings).toEqual({
    gainsDb: bass,
    enabled: true,
    postgainDb: null,
    duckMs: 0,
  })
  expect(state().applying).toBe(true)
  requests[0].result.resolve(-9.75)
  await settle()
  expect(state().postgainDb).toBe(-9.75)
  expect(state().applying).toBe(false)
})

test("an old automatic response cannot overwrite a newer manual gain or pending edit", async () => {
  state().setBand(0, 8)
  state().setPostgainDb(2.5)
  requests[0].result.resolve(-9.75)
  await settle()
  expect(state().postgainDb).toBe(2.5)
  expect(state().applying).toBe(true)
  expect(requests[1].settings.postgainDb).toBe(2.5)
  requests[1].result.resolve(2.5)
  await settle()
  expect(state().postgainDb).toBe(2.5)
  expect(state().applying).toBe(false)
})

test("first output detection recalls a saved profile and ignores its old derived gain", async () => {
  useEqStore.setState({ deviceProfiles: { Headphones: profile(bass) } })
  state().setCurrentDevice("Headphones")
  expect(state().gains).toEqual(bass)
  expect(state().currentDevice).toBe("Headphones")
  expect(requests[0].settings).toEqual({
    gainsDb: bass,
    enabled: true,
    postgainDb: null,
    duckMs: 30,
  })
  requests[0].result.resolve(-9.75)
  await settle()
  expect(state().postgainDb).toBe(-9.75)
  expect(state().deviceProfiles.Headphones.postgainDb).toBe(8)
})

test("rapid device changes and a later band edit keep the latest audible configuration", async () => {
  const speakers: EqGains = [0, 0, 0, 0, 3, 3, 0, 0, 0, 0]
  useEqStore.setState({
    deviceProfiles: { Headphones: profile(bass), Speakers: profile(speakers) },
  })
  state().setCurrentDevice("Headphones")
  state().setCurrentDevice("Speakers")
  state().setBand(4, 5)
  expect(state().gains[4]).toBe(5)
  requests[0].result.resolve(-9.75)
  requests[1].result.resolve(-4)
  await settle()
  expect(state().currentDevice).toBe("Speakers")
  expect(state().gains[4]).toBe(5)
  expect(state().applying).toBe(true)
  requests[2].result.resolve(-6)
  await settle()
  expect(state().postgainDb).toBe(-6)
  expect(state().deviceProfiles.Headphones.gains).toEqual(bass)
  expect(state().deviceProfiles.Speakers.gains).toEqual(speakers)
})

test("switching to an unknown device saves outgoing preferences and applies flat bypass", () => {
  useEqStore.setState({
    currentDevice: "Headphones",
    gains: bass,
    autoPostgain: false,
    postgainDb: 2.5,
  })
  state().setCurrentDevice("Unknown speakers")
  expect(state().deviceProfiles.Headphones).toEqual(profile(bass, true))
  expect(state().enabled).toBe(false)
  expect(requests[0].settings).toEqual({
    gainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    enabled: false,
    postgainDb: 0,
    duckMs: 30,
  })
  const count = requests.length
  state().setCurrentDevice("Unknown speakers")
  state().setCurrentDevice("")
  expect(requests).toHaveLength(count)
})

test("a first device without a profile keeps the global EQ and manual gain", () => {
  useEqStore.setState({ gains: bass, autoPostgain: false, postgainDb: 2.5 })
  state().setCurrentDevice("First speakers")
  expect(state().gains).toEqual(bass)
  expect(requests[0].settings.postgainDb).toBe(2.5)
})

test("invalid controls and corrupt profiles cannot enter the audio bridge or erase saved data", () => {
  for (const [index, db] of [
    [-1, 3],
    [10, 3],
    [0.5, 3],
    [1, NaN],
    [1, Infinity],
  ])
    state().setBand(index, db)
  state().setPostgainDb(NaN)
  state().applyPreset([1, 2] as unknown as EqGains)
  expect(requests).toHaveLength(0)
  const corrupt = { ...profile(bass), gains: [1, 2] } as unknown as EqProfile
  useEqStore.setState({ deviceProfiles: { Broken: corrupt } })
  state().loadProfileForDevice("Broken")
  expect(state().deviceProfiles.Broken).toBe(corrupt)
  expect(state().eqError).toContain("invalid")
  expect(requests).toHaveLength(0)
})

test("automatic profiles ignore corrupt derived gain and saved profile extensions survive", () => {
  const saved = {
    ...profile(bass),
    postgainDb: NaN,
    note: "Keep this profile annotation",
  }
  useEqStore.setState({ deviceProfiles: { Headphones: saved } })
  state().setCurrentDevice("Headphones")
  expect(requests[0].settings.postgainDb).toBeNull()
  state().saveProfileForDevice("Headphones")
  expect((state().deviceProfiles.Headphones as typeof saved).note).toBe(
    saved.note
  )
})

test("leaving a corrupt device profile preserves its saved data until explicitly replaced", () => {
  const saved = {
    ...profile(bass),
    gains: [1, 2],
    note: "Preserve original data",
  } as unknown as EqProfile
  useEqStore.setState({ deviceProfiles: { Broken: saved } })
  state().setCurrentDevice("Broken")
  state().setCurrentDevice("New speakers")
  expect(state().deviceProfiles.Broken).toBe(saved)
})

test("device names matching object properties cannot recall an inherited profile", () => {
  useEqStore.setState({ gains: bass })
  state().setCurrentDevice("constructor")
  expect(state().gains).toEqual(bass)
  expect(state().eqError).toBeNull()
  state().saveProfileForDevice("constructor")
  expect(Object.hasOwn(state().deviceProfiles, "constructor")).toBe(true)
  state().loadProfileForDevice("constructor")
  expect(requests.at(-1)?.settings.gainsDb).toEqual(bass)
})

test("configuration errors stay in EQ settings and a retry applies the latest selection", async () => {
  state().applyPreset(bass)
  state().setBand(0, 7)
  requests[0].result.reject(new Error("private old exception"))
  await settle()
  expect(state().eqError).toBeNull()
  requests[1].result.reject(new Error("private current exception"))
  await settle()
  expect(state().eqError).toContain("Try again")
  expect(state().eqError).not.toContain("private")
  state().syncToEngine()
  expect(requests[2].settings.gainsDb[0]).toBe(7)
  requests[2].result.resolve(0)
  await settle()
  expect(state().eqError).toBeNull()
  expect(state().postgainDb).toBe(0)
})

test("clearing the current profile survives switching away and later EQ edits", () => {
  useEqStore.setState({
    currentDevice: "Headphones",
    gains: bass,
    deviceProfiles: {
      Headphones: profile(bass),
      Speakers: profile(bass, true),
    },
  })
  state().deleteProfileForDevice("Headphones")
  state().setBand(0, 7)
  state().setCurrentDevice("Speakers")
  expect(Object.hasOwn(state().deviceProfiles, "Headphones")).toBe(false)
  state().setCurrentDevice("Headphones")
  state().setCurrentDevice("Speakers")
  expect(Object.hasOwn(state().deviceProfiles, "Headphones")).toBe(false)
  expect(state().deviceProfiles.Speakers.autoPostgain).toBe(false)
})

test("explicit Save replaces clear intent without changing unrelated profiles", () => {
  const other = profile(bass, true)
  useEqStore.setState({
    currentDevice: "Headphones",
    gains: bass,
    deviceProfiles: { Headphones: profile(bass), Speakers: other },
  })
  state().deleteProfileForDevice("Headphones")
  state().deleteProfileForDevice("Headphones")
  expect(state().clearedDeviceProfiles).toEqual(["Headphones"])
  state().saveProfileForDevice("Headphones")
  expect(state().clearedDeviceProfiles).toEqual([])
  expect(state().deviceProfiles.Headphones.gains).toEqual(bass)
  expect(state().deviceProfiles.Speakers).toBe(other)
})

test("late gain replies cannot recreate a cleared saved profile", async () => {
  useEqStore.setState({ deviceProfiles: { Headphones: profile(bass) } })
  state().setCurrentDevice("Headphones")
  state().deleteProfileForDevice("Headphones")
  requests[0].result.resolve(-9.75)
  await settle()
  expect(Object.hasOwn(state().deviceProfiles, "Headphones")).toBe(false)
  state().setCurrentDevice("Speakers")
  expect(Object.hasOwn(state().deviceProfiles, "Headphones")).toBe(false)
})
