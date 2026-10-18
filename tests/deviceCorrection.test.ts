import { expect, test } from "bun:test"
import { parseCorrection, validateCorrection, editCorrection, correctionProfile, type SavedCorrection } from "../src/audio/deviceCorrection"

const text = "Preamp: -6.1 dB\nFilter 1: ON LSC Fc 105 Hz Gain 6.4 dB Q 0.70\nFilter 2: ON PK Fc 8800 Hz Gain 5.1 dB Q 1.42\nFilter 3: OFF HSC Fc 10000 Hz Gain -2.1 dB Q 0.70\n"
test("AutoEq parametric import retains original preamp, arbitrary centers, Q, shelf types and disabled filters", () => {
  const profile = parseCorrection(`\ufeff# Source attribution\r\n${text.replaceAll("\n", "\r\n")}`)
  expect(profile.preampDb).toBe(-6.1)
  expect(profile.filters).toEqual([
    { kind: "LSC", enabled: true, frequency: 105, gainDb: 6.4, q: 0.7 },
    { kind: "PK", enabled: true, frequency: 8800, gainDb: 5.1, q: 1.42 },
    { kind: "HSC", enabled: false, frequency: 10000, gainDb: -2.1, q: 0.7 },
  ])
  expect(Object.keys(JSON.parse(JSON.stringify(profile)))).toEqual(["preampDb", "filters"])
})
test("unsupported APO commands, repeated identities and invalid finite ranges cannot become approximated profiles", () => {
  for (const invalid of [text + "Include: secret.txt", text + "Channel: L", text.replace("LSC", "HP"), text.replace("LSC", "LS"),
    text.replace("-6.1", "NaN"), text.replace("0.70", "0"), text.replace("0.70", "31"), text.replace("6.4", "31"),
    text.replace("105", "24001"), text.replace("105", "9"), text.replace("8800", "1e999"), text + "Preamp: 0 dB",
    text.replace("Filter 2:", "Filter 1:"), text.replace("Preamp: -6.1 dB", ""), " ", "\u0000" + text, text.repeat(1000)]) {
    expect(() => parseCorrection(invalid)).toThrow()
  }
  for (const value of [NaN, Infinity, -61, 13]) expect(() => validateCorrection({ ...parseCorrection(text), preampDb: value })).toThrow()
})
test("custom speaker profiles preserve labels/order while handling signed decimals and exponents", () => {
  const profile = parseCorrection("; Custom speaker measurement\nPreamp: -.5 dB\nFilter 10: on pk Fc 1e3 Hz Gain +18 dB Q .5 # local edit")
  expect(profile).toEqual({ preampDb: -0.5, filters: [{kind:"PK",frequency:1000,gainDb:18,q:0.5,enabled:true}] })
})
test("local edits never replace downloaded originals, source revision, attribution or offline settings", () => {
  const saved: SavedCorrection = { id: "saved", label: "Headphones (ANC on)", originalText: text, createdAt: 1,
    source: { kind: "autoeq", url: "https://github.com/jaakkopasanen/AutoEq", revision: "pinned", measurement: "source", rig: "rig", target: null, license: "retained notice" } }
  const changed = editCorrection(saved, text.replace("6.4", "4.1"))
  expect(saved.editedText).toBeUndefined()
  const restarted = JSON.parse(JSON.stringify(changed)) as SavedCorrection
  expect(restarted.originalText).toBe(text)
  expect(restarted.source).toEqual(saved.source)
  expect(correctionProfile(restarted).filters[0].gainDb).toBe(4.1)
  expect(editCorrection(changed, text).editedText).toBeUndefined()
})
