import { expect, test } from "bun:test"
import {
  artworkContrast,
  artworkToneFromPixels,
  createArtworkToneSampler,
} from "../src/lib/artworkTone"
function pixels(color: number[]) {
  return new Uint8ClampedArray(
    Array.from({ length: 576 }, () => [...color, 255]).flat()
  )
}
test("saturated third preserves artwork hue and ink reaches WCAG contrast across colors", () => {
  for (let r = 0; r <= 255; r += 51)
    for (let g = 0; g <= 255; g += 51)
      for (let b = 0; b <= 255; b += 51) {
        const tone = artworkToneFromPixels(pixels([r, g, b]))!
        const primary = tone.primaryRgb.split(" ").map(Number) as [
          number,
          number,
          number,
        ]
        expect(
          artworkContrast(
            primary,
            tone.ink === "#ffffff" ? [255, 255, 255] : [11, 11, 12]
          )
        ).toBeGreaterThanOrEqual(4.5)
      }
  const data = pixels([100, 100, 100])
  for (let i = 0; i < 192; i++) data.set([240, 30, 30, 255], i * 4)
  const primary = artworkToneFromPixels(data)!.primaryRgb.split(" ").map(Number)
  expect(primary[0]).toBeGreaterThan(primary[1] * 2)
  expect(artworkToneFromPixels(new Uint8ClampedArray(2304))).toBeNull()
  expect(artworkToneFromPixels([1, 2, 3, 4])).toBeNull()
})
test("samples deduplicate within scoped identities, bound workers/cache, and retry transient failure", async () => {
  const replies: Array<
    (tone: ReturnType<typeof artworkToneFromPixels>) => void
  > = []
  let active = 0,
    max = 0,
    calls = 0
  const sampler = createArtworkToneSampler(async () => {
    calls++
    active++
    max = Math.max(max, active)
    return await new Promise<ReturnType<typeof artworkToneFromPixels>>(
      (resolve) =>
        replies.push((tone) => {
          active--
          resolve(tone)
        })
    )
  }, 2)
  const first = sampler.sample("one"),
    duplicate = sampler.sample("one"),
    second = sampler.sample("two"),
    third = sampler.sample("three"),
    fourth = sampler.sample("four")
  expect(duplicate).toBe(first)
  await Promise.resolve()
  await Promise.resolve()
  expect(calls).toBe(3)
  const tone = artworkToneFromPixels(pixels([0, 200, 100]))!
  replies[0](tone)
  await first
  await Promise.resolve()
  expect(calls).toBe(4)
  replies[1](tone)
  replies[2](tone)
  replies[3](tone)
  await Promise.all([second, third, fourth])
  expect(max).toBe(3)
  expect(sampler.peek("one")).toBeUndefined()
  const fail = sampler.sample("fail")
  await Promise.resolve()
  replies[4](null)
  await fail
  const retry = sampler.sample("fail")
  await Promise.resolve()
  replies[5](tone)
  await retry
  const scoped = sampler.sample("fail", "new-account:fail")
  await Promise.resolve()
  replies[6](tone)
  await scoped
  expect(calls).toBe(7)
})
