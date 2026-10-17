import { describe, expect, test } from "bun:test"
import { transitionRows, type TransitionInfo } from "../src/audio/transitionInfo"

const plan: TransitionInfo = {
  outgoing_rating_key: 1, incoming_rating_key: 2,
  mode: "mixRamp", reason: null, start_time_ms: 9880, duration_ms: 120,
}

describe("native transition display", () => {
  test("keeps a short valid smart overlap instead of inventing a fallback", () => {
    expect(transitionRows(plan, true, false)).toEqual([
      ["Transition", "MixRamp overlap"], ["Overlap", "0.12s"], ["Starts at", "0:09"],
    ])
  })
  test("shows a duration-relative start with seconds or minutes and seconds", () => {
    expect(transitionRows(plan, true, false, 22_880)).toContainEqual(["Starts", "13s before end"])
    expect(transitionRows(plan, true, false, 82_880)).toContainEqual(["Starts", "1m 13s before end"])
    expect(transitionRows(plan, true, false, 10_000)).toContainEqual(["Starts", "0.12s before end"])
    expect(transitionRows(plan, true, false, 69_680)).toContainEqual(["Starts", "1m 0s before end"])
  })
  test("falls back to a clock position when duration is unknown or inconsistent", () => {
    const later = { ...plan, start_time_ms: 209_580 }
    for (const duration of [undefined, 0, NaN, 10_000])
      expect(transitionRows(later, true, false, duration)).toContainEqual(["Starts at", "3:29"])
  })
  test("shows the engine's actual timed fallback and its reason", () => {
    expect(transitionRows({ ...plan, mode: "timed", reason: "missingRamps", duration_ms: 4000 }, true, false))
      .toContainEqual(["Reason", "Loudness ramps unavailable"])
    expect(transitionRows({ ...plan, mode: "timed", reason: "noUsableCrossing" }, true, false))
      .toContainEqual(["Reason", "No usable loudness crossing"])
  })
  test("does not claim a calculated fade until the engine schedules one", () => {
    expect(transitionRows(null, true, false)).toEqual([["Transition", "Preparing next track…"]])
    expect(transitionRows(plan, true, true)).toEqual([["Transition", "Repeat current track"]])
    expect(transitionRows(plan, false, false)).toEqual([["Transition", "End of queue"]])
  })
})
