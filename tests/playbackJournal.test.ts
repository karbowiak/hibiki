import { describe, expect, test } from "bun:test"
import { PlaybackJournal, canScrobble, listenedEnough, startedQueueIndex, type TrackEnded } from "../src/audio/playbackJournal"

const start = (id: number) => ({ playback_id: id, rating_key: 42, duration_ms: 180000 })
const end = (id: number, overrides: Partial<TrackEnded> = {}): TrackEnded => ({
  ...start(id), position_ms: 180000, listened_ms: 170000, reason: "natural", ...overrides,
})

describe("native playback journal", () => {
  test("an outgoing fade retains its own track, timestamp and listening count", () => {
    const journal = new PlaybackJournal<{ track: string; provider: string }>()
    journal.start(start(1), { track: "outgoing", provider: "server-A" }, 100000)
    journal.start(start(2), { track: "incoming", provider: "server-A" }, 200000)
    expect(journal.finish(end(1))).toEqual({ value: { track: "outgoing", provider: "server-A" }, startedAtUnix: 100, wasCurrent: false })
    expect(journal.current()?.track).toBe("incoming")
    expect(journal.currentId).toBe(2)
    expect(journal.finish(end(1))).toBeNull()
  })
  test("two occurrences of the same song have distinct lifetimes", () => {
    const journal = new PlaybackJournal<string>()
    expect(journal.start(start(1), "same-song")).toBe(true)
    expect(journal.start(start(2), "same-song")).toBe(true)
    expect(journal.start(start(2), "duplicate-event")).toBe(false)
    expect(journal.finish(end(1))?.wasCurrent).toBe(false)
    expect(journal.finish(end(2, { reason: "stopped" }))?.wasCurrent).toBe(true)
    expect(journal.current()).toBeNull()
    expect(journal.start(start(1), "late-start-event")).toBe(false)
  })
  test("unknown or preloaded-only endings cannot create history records", () => {
    const journal = new PlaybackJournal<string>()
    expect(journal.finish(end(12))).toBeNull()
  })
  test("skipping to the end does not qualify as listening", () => {
    expect(canScrobble(180000, 500)).toBe(false)
    expect(listenedEnough(180000, 500)).toBe(false)
    expect(canScrobble(180000, 90000)).toBe(true)
    expect(canScrobble(900000, 240000)).toBe(true)
    expect(canScrobble(30000, 30000)).toBe(false)
    expect(canScrobble(30001, 15000)).toBe(false)
    expect(canScrobble(30001, 15001)).toBe(true)
    expect(canScrobble(NaN, Infinity)).toBe(false)
    expect(listenedEnough(0, 0)).toBe(false)
  })
  test("automatic transitions advance duplicate queue entries and wrap repeat-all", () => {
    expect(startedQueueIndex(["same", "same", "next"], 0, 0, "same", null)).toBe(1)
    expect(startedQueueIndex(["same", "same"], 1, 2, "same", null)).toBe(0)
    expect(startedQueueIndex(["same", "same"], 1, 0, "same", null)).toBeNull()
    expect(startedQueueIndex(["same", "same"], 0, 0, "same", "same")).toBe(0)
    expect(startedQueueIndex(["same", "next"], 0, 0, "unexpected", null)).toBeNull()
  })
})

test("retiring renderer records after acknowledged shutdown rejects late duplicate starts and ends", () => {
  const journal = new PlaybackJournal<string>()
  journal.start(start(1), "track")
  journal.clear()
  expect(journal.current()).toBeNull()
  expect(journal.start(start(1), "late track")).toBe(false)
  expect(journal.finish(end(1))).toBeNull()
})
