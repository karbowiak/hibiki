import { describe, expect, test } from "bun:test"
import { PlaybackGain, PLAYBACK_FADE_SECONDS } from "../src/audio/PlaybackGain"
import { RadioAudioPlayer, radioVolumeGain } from "../src/lib/radioAudio"
import { deferred, FakeAudio, FakeContext, FakeParam, FakeTimers, settle } from "./helpers/radioAudioFakes"

function station() {
  const audio = new FakeAudio()
  const context = new FakeContext()
  const timers = new FakeTimers(context)
  const player = new RadioAudioPlayer(audio as unknown as HTMLAudioElement, context as unknown as AudioContext, timers)
  const events: string[] = []
  player.subscribe({
    onPlaying: () => events.push("playing"), onWaiting: () => events.push("waiting"),
    onPause: () => events.push("pause"), onError: msg => events.push(msg), onStop: () => events.push("stop"),
  })
  return { player, audio, context, timers, events, master: context.gains[0].gain, playback: context.gains[1].gain }
}

describe("radio playback fades", () => {
  test("buffering cannot consume the fade before the media element starts playing", async () => {
    const s = station()
    s.player.start("https://radio.example.test/live", 80)
    await settle()
    expect(s.playback.curves).toHaveLength(0)
    s.timers.advance(5000)
    s.audio.emit("playing")
    expect(s.playback.curves[0].time).toBe(5)
    expect(s.playback.curves[0].duration).toBe(PLAYBACK_FADE_SECONDS)
    expect(s.playback.curves[0].values[0]).toBe(0)
    expect(s.master.value).toBeCloseTo(0.512)
    s.player.setVolume(80)
    expect(s.master.value).toBeCloseTo(0.512)
    s.player.setVolume(50)
    expect(s.master.value).toBe(0.125)
    expect(s.playback.curves).toHaveLength(1)
    s.audio.emit("waiting")
    expect(s.playback.values.at(-1)?.value).toBe(0)
    s.timers.advance(5000)
    s.audio.emit("playing")
    expect(s.playback.curves.at(-1)?.values[0]).toBe(0)
    s.player.stop()
  })

  test("pause renders its 150 ms tail once and resume reverses the current gain", async () => {
    const s = station()
    s.player.start("https://radio.example.test/live", 100)
    await settle()
    s.audio.emit("playing")
    s.timers.advance(150)
    s.player.pause()
    expect(s.audio.paused).toBe(false)
    expect(s.playback.curves.at(-1)?.values[0]).toBe(1)
    s.timers.advance(75)
    s.player.pause()
    expect(s.timers.pending.size).toBe(1)
    s.player.resume()
    expect(s.playback.curves.at(-1)?.values[0]).toBeCloseTo(0.5)
    expect(s.timers.pending.size).toBe(0)
    // Even an already-queued callback cannot pause a newer resume.
    s.timers.archive[0]()
    expect(s.audio.paused).toBe(false)
    await settle()
    s.timers.advance(150)
    s.player.pause()
    s.timers.advance(149)
    expect(s.audio.paused).toBe(false)
    s.timers.advance(1)
    expect(s.audio.paused).toBe(true)
    s.audio.flushEvents()
    expect(s.events.at(-1)).toBe("pause")
    s.player.stop()
  })

  test("a deferred pause event cannot undo a resume while context.resume is pending", async () => {
    const s = station()
    s.player.start("https://radio.example.test/live", 100)
    await settle()
    s.audio.emit("playing")
    s.timers.advance(150)
    s.player.pause()
    s.timers.advance(150)
    const resume = deferred()
    s.context.resumeResult = resume.promise
    s.player.resume()
    const before = s.events.length
    s.audio.flushEvents()
    expect(s.events).toHaveLength(before)
    resume.resolve()
    await settle()
    expect(s.audio.playCalls).toBe(2)
    s.audio.emit("playing")
    expect(s.events.at(-1)).toBe("playing")
    s.player.stop()
  })

  test("stopped or paused requests cannot play later or surface stale rejections", async () => {
    for (const action of ["stop", "pause"] as const) {
      const s = station()
      const resume = deferred()
      s.context.resumeResult = resume.promise
      s.player.start("https://radio.example.test/live", 80)
      s.player[action]()
      resume.resolve()
      await settle()
      expect(s.audio.playCalls).toBe(0)
      s.player.stop()
    }
    const s = station()
    const play = deferred()
    s.audio.playResult = play.promise
    s.player.start("https://radio.example.test/live", 80)
    await settle()
    s.player.stop()
    play.reject(new Error("secret stream URL"))
    await settle()
    expect(s.events).toEqual(["waiting", "stop"])
  })

  test("startup failures replay to late listeners and Stop releases the entire graph once", async () => {
    const s = station()
    s.audio.playResult = Promise.reject(new Error("https://radio.example.test/private?token=secret"))
    s.player.start("https://radio.example.test/live", 80)
    await settle()
    const late: string[] = []
    s.player.subscribe({ onError: error => late.push(error) })
    expect(late).toEqual(["Could not start this radio stream. Try playing it again."])
    s.player.stop()
    s.player.stop()
    s.audio.flushEvents()
    s.audio.emit("error")
    s.audio.emit("playing")
    expect(s.audio.src).toBe("")
    expect(s.audio.listeners.size).toBe(0)
    expect(s.context.closeCalls).toBe(1)
    expect(s.context.source.disconnectCalls).toBe(1)
    expect(s.context.gains.map(g => g.disconnectCalls)).toEqual([1, 1])
    expect(s.events.at(-1)).toBe("stop")
  })

  test("invalid stream schemes and nonfinite volumes are rejected safely", async () => {
    const s = station()
    s.player.start("file:///private/station", 80)
    await settle()
    expect(s.audio.playCalls).toBe(0)
    expect(s.events).toEqual(["This station does not have a valid HTTP or HTTPS stream."])
    for (const v of [NaN, Infinity, -Infinity, -1]) expect(radioVolumeGain(v)).toBe(0)
    expect(radioVolumeGain(200)).toBe(1)
    s.player.stop()
  })
})

test("gain reversals match interpolation of an interrupted curve and duplicate controls do not restart it", () => {
  const param = new FakeParam()
  const context = { currentTime: 0 }
  const envelope = new PlaybackGain(param, context)
  envelope.fadeTo(1)
  envelope.fadeTo(1)
  expect(param.curves).toHaveLength(1)
  context.currentTime = 0.033
  const curve = param.curves[0].values
  const index = context.currentTime / PLAYBACK_FADE_SECONDS * (curve.length - 1)
  const lo = Math.floor(index)
  const value = curve[lo] + (curve[lo + 1] - curve[lo]) * (index - lo)
  envelope.fadeTo(0)
  expect(param.curves[1].values[0]).toBeCloseTo(value, 6)
  expect(param.curves[1].values.at(-1)).toBe(0)
  envelope.silence()
  envelope.fadeTo(1)
  expect(param.curves.at(-1)?.values[0]).toBe(0)
})
