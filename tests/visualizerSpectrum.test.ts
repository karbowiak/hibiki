import { expect, test } from "bun:test"
import { computeSpectrumFromFFT } from "../src/lib/visualizerSpectrum"

test("native FFT bands preserve silence and tolerate unavailable startup data", () => {
  for (const data of [new Float32Array(), new Float32Array(1025).fill(-100)]) {
    expect([...computeSpectrumFromFFT(data, 64, 48000)]).toEqual(
      Array(64).fill(0)
    )
  }
  expect([...computeSpectrumFromFFT(new Float32Array(1025), 64, 0)]).toEqual(
    Array(64).fill(0)
  )
})

test("native FFT frequency bands track the actual device sample rate", () => {
  for (const sampleRate of [44100, 48000, 96000]) {
    const data = new Float32Array(1025).fill(-100)
    const frequency = 1000
    data[Math.round((frequency / (sampleRate / 2)) * data.length)] = -5
    const bands = computeSpectrumFromFFT(data, 64, sampleRate)
    const strongest = [...bands].indexOf(Math.max(...bands))
    const lower =
      20 * Math.pow(Math.min(sampleRate / 2, 20000) / 20, strongest / 64)
    const upper =
      20 * Math.pow(Math.min(sampleRate / 2, 20000) / 20, (strongest + 1) / 64)
    expect(frequency).toBeGreaterThanOrEqual(lower * 0.9)
    expect(frequency).toBeLessThanOrEqual(upper * 1.1)
  }
})
