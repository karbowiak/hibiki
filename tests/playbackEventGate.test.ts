import { expect, test } from "bun:test"
import { PlaybackEventGate } from "../src/audio/playbackEventGate"

test("events preceding the native acknowledgement are delivered only for the selected request", () => {
  const gate = new PlaybackEventGate()
  const received: string[] = []
  const ticket = gate.begin()
  gate.accept(10, () => received.push("old position"))
  gate.accept(11, () => received.push("selected started"))
  gate.confirm(ticket, 11)
  gate.accept(10, () => received.push("old error"))
  gate.accept(11, () => received.push("selected position"))
  expect(received).toEqual(["selected started", "selected position"])
})

test("a late acknowledgement and queued end events cannot resurrect playback after stop", () => {
  const gate = new PlaybackEventGate()
  let delivered = 0
  const ticket = gate.begin()
  gate.accept(1, () => ++delivered)
  gate.disable()
  gate.confirm(ticket, 1)
  gate.accept(1, () => ++delivered)
  expect(delivered).toBe(0)
})

test("rapid plays ignore the older invoke response", () => {
  const gate = new PlaybackEventGate()
  const old = gate.begin()
  const current = gate.begin()
  const received: number[] = []
  gate.accept(2, () => received.push(2))
  gate.confirm(old, 1)
  gate.confirm(current, 2)
  expect(received).toEqual([2])
})
