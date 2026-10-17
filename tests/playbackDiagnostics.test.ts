import { expect, test } from "bun:test"
import { gainDecibels, transferKiBPerSecond, type PlaybackDiagnosticsSnapshot } from "../src/audio/playbackDiagnostics"
function transfer(bytes: number, playbackId = 1, kind = "network"): PlaybackDiagnosticsSnapshot {
  return { playbackId, source: { kind, downloadedBytes: bytes } } as PlaybackDiagnosticsSnapshot
}
test("transfer rates require the same observed network occurrence and a bounded sampling interval", () => {
  const previous = { at: 1000, snapshot: transfer(1024) }
  expect(transferKiBPerSecond(previous, transfer(2048), 1500)).toBe(2)
  expect(transferKiBPerSecond(previous, transfer(2048, 2), 1500)).toBe(null)
  expect(transferKiBPerSecond(previous, transfer(2048, 1, "cache"), 1500)).toBe(null)
  expect(transferKiBPerSecond(previous, transfer(2048), 5000)).toBe(null)
  expect(transferKiBPerSecond(previous, transfer(0), 1500)).toBe(null)
  expect(transferKiBPerSecond(null, transfer(2048), 1500)).toBe(null)
})
test("zero-byte progress is zero throughput rather than unknown or an invented file bitrate", () => {
  expect(transferKiBPerSecond({ at: 1000, snapshot: transfer(4096) }, transfer(4096), 1500)).toBe(0)
})
test("gain readouts distinguish unity, attenuation, silence and unavailable data", () => {
  expect(gainDecibels(1)).toBe("0.0 dB")
  expect(gainDecibels(0.5)).toBe("-6.0 dB")
  expect(gainDecibels(0)).toBe("Muted")
  expect(gainDecibels(Number.NaN)).toBe("Unknown")
})
