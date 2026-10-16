import { expect, test } from "bun:test"
import { artworkPlacement } from "../src/lib/artworkLayout"
test("sharp and ambient artwork share scale and focal crop across content sizes", () => {
  expect(artworkPlacement(1000, 400, 2000, 1000, 0.5, 0.3)).toEqual({
    width: 1000,
    height: 500,
    left: 0,
    top: 0,
  })
  expect(artworkPlacement(400, 500, 1000, 1000, 0.2, 0.8)).toEqual({
    width: 500,
    height: 500,
    left: 0,
    top: 0,
  })
  expect(artworkPlacement(400, 500, 0, 1000)).toBeNull()
  expect(artworkPlacement(400, NaN, 1000, 1000)).toBeNull()
})

test("a portrait's upper focal point is kept visible without any extra zoom", () => {
  const crop = artworkPlacement(1600, 600, 1000, 1500, 0.5, 0.2)!
  expect(crop.width).toBe(1600)
  expect(crop.height).toBe(2400)
  expect(crop.top + crop.height * 0.2).toBe(300)
  // CSS background-position: 20% would put the subject at 120px, not center it.
  expect(crop.top).toBe(-180)
  for (const point of [0, 0.2, 0.5, 0.9, 1, NaN]) {
    const placement = artworkPlacement(1600, 600, 1000, 1500, point, point)!
    expect(placement.left).toBeLessThanOrEqual(0)
    expect(placement.top).toBeLessThanOrEqual(0)
    expect(placement.left + placement.width).toBeGreaterThanOrEqual(1600)
    expect(placement.top + placement.height).toBeGreaterThanOrEqual(600)
  }
})

test("fit uses the full client height, while only unavoidable cropping follows the hero focus", () => {
  // Matching aspect ratios preserve the entire image, regardless of hero height.
  expect(artworkPlacement(1600, 900, 1920, 1080, 0.5, 0.25, 450)).toEqual({
    width: 1600,
    height: 900,
    left: 0,
    top: 0,
  })
  // A 4:3 photo in a 16:9 client loses only its aspect-ratio excess.
  const photo = artworkPlacement(1600, 900, 1600, 1200, 0.5, 0.2, 450)!
  expect(photo.width).toBe(1600)
  expect(photo.height).toBe(1200)
  expect(photo.top).toBe(-15)
  expect(photo.top + photo.height).toBeGreaterThanOrEqual(900)
})
