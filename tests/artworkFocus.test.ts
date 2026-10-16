import { expect, test } from "bun:test"
import { artworkFocusFromPixels } from "../src/lib/artworkFocus"

function fixture() {
  const pixels = new Uint8ClampedArray(100 * 100 * 4)
  const patch = (
    left: number,
    top: number,
    width: number,
    height: number,
    rgb: number[]
  ) => {
    for (let y = top; y < top + height; y++)
      for (let x = left; x < left + width; x++)
        pixels.set([...rgb, 255], (y * 100 + x) * 4)
  }
  return { pixels, patch }
}
test("local detail wins instead of averaging a head with distant clothing", () => {
  const { pixels, patch } = fixture()
  patch(40, 10, 20, 20, [190, 120, 85])
  patch(35, 68, 30, 25, [170, 170, 170])
  const point = artworkFocusFromPixels(pixels, 100)
  expect(point.x).toBeGreaterThan(0.35)
  expect(point.x).toBeLessThan(0.65)
  expect(point.y).toBeLessThan(0.35)
})
test("a clear lower subject still wins, and uniformly colored artwork stays centered", () => {
  const { pixels, patch } = fixture()
  patch(60, 65, 20, 20, [240, 240, 240])
  expect(artworkFocusFromPixels(pixels, 100).y).toBeGreaterThan(0.6)
  patch(0, 0, 100, 100, [160, 100, 60])
  expect(artworkFocusFromPixels(pixels, 100)).toEqual({ x: 0.5, y: 0.5 })
})
test("the skin cue works across brightness levels, and transparent detail is ignored", () => {
  for (const brightness of [0.25, 0.5, 1]) {
    const { pixels, patch } = fixture()
    patch(
      40,
      10,
      20,
      20,
      [200, 130, 90].map((v) => v * brightness)
    )
    expect(artworkFocusFromPixels(pixels, 100).y).toBeLessThan(0.35)
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 0
    expect(artworkFocusFromPixels(pixels, 100)).toEqual({ x: 0.5, y: 0.5 })
  }
  expect(artworkFocusFromPixels(new Uint8ClampedArray(0), 100)).toEqual({
    x: 0.5,
    y: 0.5,
  })
})
