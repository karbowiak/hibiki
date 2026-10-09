import { expect, test } from "bun:test"
import { dispatchPlaybackWhenReady } from "../src/audio/playbackRequests"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

test("rapid skips cannot send a late metadata result to the native player", async () => {
  let selection = 1
  const first = deferred<string>()
  const sent: string[] = []
  const old = dispatchPlaybackWhenReady(() => first.promise, () => selection === 1,
    async track => { sent.push(track) })
  selection = 2
  const latest = await dispatchPlaybackWhenReady(async () => "selected", () => selection === 2,
    async track => { sent.push(track) })
  first.resolve("old")
  expect(await old).toBe(false)
  expect(latest).toBe(true)
  expect(sent).toEqual(["selected"])
})

test("stop while resolving playback prevents a delayed start or preload", async () => {
  let active = true
  const ready = deferred<string>()
  const sent: string[] = []
  const pending = dispatchPlaybackWhenReady(() => ready.promise, () => active,
    async value => { sent.push(value) })
  active = false
  ready.resolve("track")
  expect(await pending).toBe(false)
  expect(sent).toEqual([])
})

test("a selection changed during native dispatch suppresses follow-up preloading", async () => {
  let active = true
  const result = await dispatchPlaybackWhenReady(async () => "track", () => active,
    async () => { active = false })
  expect(result).toBe(false)
})
