import { expect, test } from "bun:test"
import { artworkContrast } from "../src/lib/artworkTone"
import {
  artworkUiPalette,
  readableArtworkColor,
} from "../src/lib/artworkUiPalette"
const channels = (value: string) =>
  value.match(/[\d.]+/g)!.map(Number) as [number, number, number]
test("artwork text keeps a sampled hue readable on light, dark and custom surfaces", () => {
  for (const background of [
    "rgb(18 18 18)",
    "rgb(255 255 255)",
    "rgb(22 37 48)",
    "rgb(220 228 235)",
  ])
    for (const source of [
      "rgb(230 32 150)",
      "rgb(25 50 170)",
      "rgb(30 190 175)",
      "rgb(170 170 170)",
    ]) {
      const result = readableArtworkColor(source, background)
      expect(
        artworkContrast(channels(result), channels(background))
      ).toBeGreaterThanOrEqual(7)
    }
  expect(readableArtworkColor("rgb(200 40 80)", "var(--custom)")).toBe(
    "var(--text-primary)"
  )
})
test("artwork accents are scoped aliases and restore normal preferences when disabled", () => {
  const tone = {
    "--artwork-primary": "rgb(230 32 150)",
    "--artwork-primary-rgb": "230 32 150",
    "--artwork-secondary": "rgb(32 230 120)",
    "--artwork-secondary-rgb": "32 230 120",
    "--artwork-ink": "#0b0b0c",
  }
  const palette = artworkUiPalette(tone, "#121212") as Record<string, string>
  expect(palette["--accent"]).toBe("#e62096")
  expect(palette["--accent-tint"]).toBe("rgb(230 32 150 / 0.08)")
  expect(palette["--artwork-ink"]).toBe(tone["--artwork-ink"])
  expect(artworkUiPalette(undefined, "#121212")).toBeUndefined()
})
