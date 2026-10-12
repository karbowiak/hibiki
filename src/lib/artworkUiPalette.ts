import type { CSSProperties } from "react"
import { artworkContrast } from "./artworkTone"

type RGB = [number, number, number]
function parseColor(value: string): RGB | null {
  const hex = /^#([\da-f]{6})$/i.exec(value)
  if (hex)
    return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as RGB
  const channels =
    /^rgba?\(/.test(value) && !value.includes("%")
      ? value.match(/[\d.]+/g)?.map(Number)
      : null
  if (
    channels &&
    channels.length >= 3 &&
    channels.slice(0, 3).every((v) => v >= 0 && v <= 255)
  )
    return channels.slice(0, 3) as RGB
  return null
}
/** Keep a sampled hue, adjusting its text variant for the user's surface. */
export function readableArtworkColor(
  color: string,
  background: string
): string {
  const source = parseColor(color),
    base = parseColor(background)
  if (!source || !base) return "var(--text-primary)"
  // Extra margin covers the softly tinted artwork underneath the page wash.
  if (artworkContrast(source, base) >= 7) return `rgb(${source.join(" ")})`
  const target: RGB =
    artworkContrast([0, 0, 0], base) > artworkContrast([255, 255, 255], base)
      ? [0, 0, 0]
      : [255, 255, 255]
  for (let step = 1; step <= 100; step++) {
    const adjusted = source.map((value, i) =>
      Math.round(value + ((target[i] - value) * step) / 100)
    ) as RGB
    if (artworkContrast(adjusted, base) >= 7)
      return `rgb(${adjusted.join(" ")})`
  }
  return `rgb(${target.join(" ")})`
}
/** Scoped accent aliases keep existing controls coherent without changing saved preferences. */
export function artworkUiPalette(
  tone: CSSProperties | undefined,
  background: string
): CSSProperties | undefined {
  const values = tone as Record<string, string> | undefined
  if (!values?.["--artwork-primary-rgb"]) return undefined
  const primary = values["--artwork-primary"],
    channels = values["--artwork-primary-rgb"]
  return {
    ...tone,
    // Existing canvas visualizers parse this alias as a hex color.
    "--accent":
      "#" +
      channels
        .split(/\s+/)
        .map((channel) => Number(channel).toString(16).padStart(2, "0"))
        .join(""),
    "--accent-rgb": channels,
    "--accent-tint": `rgb(${channels} / 0.08)`,
    "--accent-tint-subtle": `rgb(${channels} / 0.04)`,
    "--accent-tint-strong": `rgb(${channels} / 0.15)`,
    "--accent-tint-hover": `rgb(${channels} / 0.12)`,
    "--hl-card": `rgb(${channels} / var(--hl-card-opacity))`,
    "--hl-row": `rgb(${channels} / var(--hl-row-opacity))`,
    "--hl-menu": `rgb(${channels} / var(--hl-menu-opacity))`,
    "--hl-queue": `rgb(${channels} / var(--hl-queue-opacity))`,
    "--artwork-accent-text": readableArtworkColor(primary, background),
    "--artwork-hero-primary": readableArtworkColor(primary, "#282828"),
    "--artwork-hero-secondary": readableArtworkColor(
      values["--artwork-secondary"],
      "#282828"
    ),
  } as CSSProperties
}
