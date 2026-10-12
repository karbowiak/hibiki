import { expect, test } from "bun:test"
import { clampWaveformProgress, normalizeWaveformLoudness, waveformBarGeometry } from "../src/lib/waveformGeometry"
test("waveform loudness shaping keeps its floor, peak and finite display range", () => {
  const result = normalizeWaveformLoudness([-80, -35, -20, 0, NaN, Infinity].map(loudness => ({ loudness })))
  expect(result[0]).toBe(0); expect(result[1]).toBe(0); expect(result[3]).toBe(1)
  expect(result[2]).toBeGreaterThan(0); expect(result[2]).toBeLessThan(1)
  expect(result.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true)
  expect(normalizeWaveformLoudness([])).toEqual([])
  expect(normalizeWaveformLoudness([{ loudness: Number.MAX_VALUE }, { loudness: 1e150 }, { loudness: 5 }]).every(Number.isFinite)).toBe(true)
})
test("waveform bars are symmetric, bounded and keep late transients across the complete track", () => {
  const samples = new Array(10000).fill(0); samples[9999] = 1
  for (const dpr of [1, 2, 3]) {
    const width = 600 * dpr, height = 28 * dpr
    const bars = waveformBarGeometry(samples, width, height, dpr)
    expect(bars.length).toBe(150)
    expect(bars.at(-1)!.height).toBeCloseTo(height * 0.82)
    expect(bars[0].height).toBe(2 * dpr)
    for (const bar of bars) {
      expect(bar.y + bar.height / 2).toBeCloseTo(height / 2)
      expect(bar.x >= 0 && bar.x + bar.width <= width && bar.y >= 0 && bar.y + bar.height <= height).toBe(true)
    }
  }
})
test("empty, single, corrupt and tiny waveforms never produce NaN or leave their bounds", () => {
  expect(waveformBarGeometry([], 600, 28)).toEqual([{ x: 0, y: 13, width: 600, height: 2 }])
  for (const samples of [[1], [NaN, Infinity, -1], [0, 1]]) for (const width of [0.2, 1, 30, 600]) {
    const bars = waveformBarGeometry(samples, width, 1, 2)
    expect(bars.length).toBeGreaterThan(0)
    expect(bars.every(bar => Object.values(bar).every(Number.isFinite) && bar.x + bar.width <= width && bar.height <= 1)).toBe(true)
  }
  expect(waveformBarGeometry([1], NaN, 28)).toEqual([])
  expect(waveformBarGeometry([1], 0, 28)).toEqual([])
  expect(waveformBarGeometry([1], 600, -1)).toEqual([])
  expect([-100, 0, 50, 100, 200, NaN, Infinity].map(clampWaveformProgress)).toEqual([0, 0, 50, 100, 100, 0, 0])
})
