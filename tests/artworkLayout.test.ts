import { expect, test } from "bun:test"
import { artworkPlacement } from "../src/lib/artworkLayout"
test("sharp and ambient artwork share scale and focal crop across content sizes", () => {
  expect(artworkPlacement(1000, 400, 2000, 1000, 0.5, 0.3)).toEqual({
    width: 1000,
    height: 500,
    left: 0,
    top: -30,
  })
  expect(artworkPlacement(400, 500, 1000, 1000, 0.2, 0.8)).toEqual({
    width: 500,
    height: 500,
    left: -20,
    top: 0,
  })
  expect(artworkPlacement(400, 500, 0, 1000)).toBeNull()
  expect(artworkPlacement(400, NaN, 1000, 1000)).toBeNull()
})
