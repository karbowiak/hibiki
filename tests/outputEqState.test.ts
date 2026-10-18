import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { useEqStore } from "../src/stores/eqStore"
import {
  engine,
  type AppliedEq,
  type EqSceneConfiguration,
} from "../src/audio/RustAudioEngine"
import type { OutputIdentity } from "../src/audio/outputIdentity"
import {
  correctionProfile,
  type SavedCorrection,
} from "../src/audio/deviceCorrection"
import { deferred, settle } from "./helpers/radioAudioFakes"
import { outputEqMatches } from "../src/stores/outputEqState"

const original = engine.configureEqScene,
  initial = useEqStore.getState()
const state = () => useEqStore.getState()
const output = (
  id: string,
  key = id,
  name = "USB DAC",
  stable = true
): OutputIdentity => ({ id, key, name, stable, available: true })
const saved = (id = "headphone"): SavedCorrection => ({
  id,
  label: id,
  originalText: "Preamp: -6 dB\nFilter 1: ON PK Fc 1234 Hz Gain 4 dB Q 2.5",
  createdAt: 1,
  source: {
    kind: "autoeq",
    url: "https://raw.githubusercontent.com/example/pinned.txt",
    revision: "a".repeat(40),
    measurement: "measurement",
    rig: "rig",
    target: null,
    license: "MIT License",
  },
})
const applied: AppliedEq = {
  tonePostgainDb: -3,
  effectivePostgainDb: -3,
  correctionPreampDb: -6,
  safetyDb: 0,
  sampleRate: 48000,
}
const requests: {
  settings: EqSceneConfiguration
  result: ReturnType<typeof deferred<AppliedEq>>
}[] = []
engine.configureEqScene = (settings) => {
  const result = deferred<AppliedEq>()
  requests.push({ settings, result })
  return result.promise
}
beforeEach(() => {
  useEqStore.setState(initial)
  requests.length = 0
})
afterEach(async () => {
  requests.forEach((request) => request.result.resolve(applied))
  await settle()
})
afterAll(() => {
  engine.configureEqScene = original
  useEqStore.setState(initial)
})

test("stable outputs recall independent tone and correction settings through A → B → A", () => {
  state().setCurrentOutput(output("1"))
  state().saveCorrection(saved())
  state().setBand(0, 4)
  state().saveOutputProfile()
  state().setCurrentOutput(output("2"))
  expect(state().selectedCorrectionId).toBeNull()
  expect(state().enabled).toBe(false)
  expect(requests.at(-1)!.settings.correction).toBeNull()
  state().setBand(0, -2)
  state().saveOutputProfile()
  state().setCurrentOutput(output("1", "3", "Renamed DAC"))
  expect(state().selectedCorrectionId).toBe("headphone")
  expect(state().gains[0]).toBe(4)
  expect(requests.at(-1)!.settings.correction).toEqual(
    correctionProfile(saved())
  )
  expect(state().outputProfiles["2"].gains[0]).toBe(-2)
})

test("saved output feedback distinguishes actual edits from derived automatic gain", () => {
  state().setCurrentOutput(output("1"))
  expect(outputEqMatches(state(), undefined)).toBe(false)
  state().saveCorrection(saved())
  state().saveOutputProfile()
  const profile = state().outputProfiles["1"]
  expect(outputEqMatches(state(), profile)).toBe(true)
  useEqStore.setState({ postgainDb: -4.5 })
  expect(outputEqMatches(state(), profile)).toBe(true)
  state().setBand(0, 2)
  expect(outputEqMatches(state(), profile)).toBe(false)
  state().recallOutputProfile()
  state().setCorrectionEnabled(false)
  expect(outputEqMatches(state(), profile)).toBe(false)
})

test("reconnect invalidates acknowledgements and preserves the saved profile for recall", async () => {
  state().setCurrentOutput(output("1"))
  state().saveCorrection(saved())
  state().saveOutputProfile()
  const previous = requests.at(-1)!
  state().setCurrentOutput({ ...output("1"), available: false })
  previous.result.resolve(applied)
  await settle()
  expect(state().appliedEq).toBeNull()
  state().setCurrentOutput(output("1", "2"))
  expect(state().selectedCorrectionId).toBe("headphone")
  previous.result.reject(Error("old failure"))
  requests.at(-1)!.result.resolve(applied)
  await settle()
  expect(state().appliedOutputKey).toBe("2")
  expect(state().eqError).toBeNull()
})

test("ambiguous display names do not migrate legacy profiles, and a legacy name gets one owner", () => {
  const legacy = {
    gains: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0] as any,
    enabled: true,
    autoPostgain: true,
    postgainDb: 7,
  }
  useEqStore.setState({ deviceProfiles: { "USB DAC": legacy } })
  state().setCurrentOutput(output("1"), false)
  expect(state().outputProfiles["1"]).toBeUndefined()
  state().setCurrentOutput(output("2"), true)
  expect(state().outputProfiles["2"]).toBeUndefined()
  expect(state().deviceProfiles["USB DAC"]).toBe(legacy)
  useEqStore.setState({
    deviceProfiles: { ...state().deviceProfiles, "Unique DAC": legacy },
  })
  state().setCurrentOutput(output("3", "3", "Unique DAC"), true)
  expect(state().outputProfiles["3"].legacyName).toBe("Unique DAC")
  state().removeOutputProfile("3")
  state().setCurrentOutput(output("4", "4", "Unique DAC"), true)
  expect(state().outputProfiles["4"]).toBeUndefined()
  state().setCurrentOutput(output("3", "5", "Unique DAC"), true)
  expect(state().outputProfiles["3"]).toBeUndefined()
})

test("automatic recall can be disabled while manual selection remains usable on a shared DAC", () => {
  state().setCurrentOutput(output("1"))
  state().saveCorrection(saved())
  state().saveOutputProfile()
  state().setAutomaticRecall(false)
  state().setCurrentOutput(output("2"))
  state().setCurrentOutput(output("1", "3"))
  expect(state().selectedCorrectionId).toBeNull()
  state().recallOutputProfile()
  expect(state().selectedCorrectionId).toBe("headphone")
  state().setCurrentOutput(output("alsa:default", "4", "Default", false))
  state().saveCorrection(saved("speaker"))
  state().saveOutputProfile()
  state().setAutomaticRecall(true)
  expect(state().outputProfiles["alsa:default"].automatic).toBe(false)
  state().setCurrentOutput({
    ...output("alsa:default", "4", "Default", false),
    available: false,
  })
  state().setCurrentOutput(output("alsa:default", "5", "Default", false))
  expect(state().selectedCorrectionId).toBeNull()
  state().recallOutputProfile()
  expect(state().selectedCorrectionId).toBe("speaker")
})

test("preview cancellation restores local edits and cannot affect a subsequently selected output", () => {
  state().setCurrentOutput(output("1"))
  state().saveCorrection({
    ...saved(),
    editedText: saved().originalText.replace("-6", "-8"),
  })
  state().previewCorrection(saved("preview"), "1")
  expect(state().corrections.preview).toBeUndefined()
  expect(requests.at(-1)!.settings.correction?.preampDb).toBe(-6)
  state().cancelCorrectionPreview("1")
  expect(requests.at(-1)!.settings.correction?.preampDb).toBe(-8)
  state().previewCorrection(saved("preview"), "1")
  state().setCurrentOutput(output("2"))
  const count = requests.length
  state().cancelCorrectionPreview("1")
  state().previewCorrection(saved(), "1")
  expect(requests).toHaveLength(count)
  expect(state().selectedCorrectionId).toBeNull()
})

test("editing and offline serialization retain immutable source and required headroom", () => {
  state().setCurrentOutput(output("1"))
  state().saveCorrection(saved())
  state().saveCorrection({
    ...saved(),
    originalText: "wrong",
    source: { ...saved().source, revision: "wrong" },
    editedText: saved().originalText.replace("-6", "-9"),
  })
  const offline: SavedCorrection = JSON.parse(
    JSON.stringify(state().corrections.headphone)
  )
  expect(offline.originalText).toBe(saved().originalText)
  expect(offline.source).toEqual(saved().source)
  expect(correctionProfile(offline).preampDb).toBe(-9)
  state().setCorrectionEnabled(false)
  expect(requests.at(-1)!.settings.correction).toBeNull()
  state().setCorrectionEnabled(true)
  expect(requests.at(-1)!.settings.correction?.preampDb).toBe(-9)
  state().saveOutputProfile()
  state().removeCorrection("headphone")
  expect(state().outputProfiles["1"].correctionId).toBeNull()
})

test("failed preparation reports no applied profile and a later scene can recover", async () => {
  state().setCurrentOutput(output("1"))
  requests
    .at(-1)!
    .result.reject("This correction needs a higher mixer sample rate")
  await settle()
  expect(state().appliedEq).toBeNull()
  expect(state().eqError).toContain("higher mixer")
  state().syncToEngine()
  requests.at(-1)!.result.resolve(applied)
  await settle()
  expect(state().appliedEq).toEqual(applied)
  expect(state().eqError).toBeNull()
})

test("losing output identity cannot fall back to unfenced legacy tone commands", () => {
  state().setCurrentOutput(output("1"))
  state().saveCorrection(saved())
  state().setCurrentOutput(null)
  const count = requests.length
  state().setBand(0, 3)
  state().syncToEngine()
  expect(state().outputIdentityKnown).toBe(true)
  expect(state().selectedCorrectionId).toBeNull()
  expect(state().appliedEq).toBeNull()
  expect(requests).toHaveLength(count)
  expect(state().applying).toBe(false)
})

test("a corrupt incoming binding cannot inherit or retry the preceding output's correction", () => {
  state().setCurrentOutput(output("1"))
  state().saveCorrection(saved())
  state().saveOutputProfile()
  const invalid = { ...state().outputProfiles["1"], gains: [Number.NaN] as any }
  useEqStore.setState({
    outputProfiles: { ...state().outputProfiles, "2": invalid },
  })
  state().setCurrentOutput(output("2"))
  expect(state().eqError).toContain("invalid")
  expect(state().selectedCorrectionId).toBeNull()
  expect(state().enabled).toBe(false)
  state().syncToEngine()
  expect(requests.at(-1)!.settings.correction).toBeNull()
  state().setCurrentOutput(output("1", "3"))
  expect(state().outputProfiles["2"]).toBe(invalid)
  expect(state().selectedCorrectionId).toBe("headphone")
})

test("applying a library correction does not silently create an automatic output binding", () => {
  state().setCurrentOutput(output("1"))
  state().saveCorrection(saved())
  state().setCurrentOutput(output("2"))
  state().setCurrentOutput(output("1", "3"))
  expect(state().outputProfiles["1"]).toBeUndefined()
  expect(state().selectedCorrectionId).toBeNull()
  expect(state().corrections.headphone.originalText).toBe(saved().originalText)
})
