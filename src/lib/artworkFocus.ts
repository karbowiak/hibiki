export type FocalPoint = { x: number; y: number }

/** Small, local saliency regions avoid placing the focus between distant subjects.
 * This is a composition heuristic, not face recognition. No model is involved. */
export function artworkFocusFromPixels(
  pixels: Uint8ClampedArray,
  size: number
): FocalPoint {
  const center = { x: 0.5, y: 0.5 }
  if (size < 8 || size > 128 || pixels.length !== size * size * 4) return center
  const luminance = new Float32Array(size * size)
  for (let i = 0; i < luminance.length; i++) {
    const offset = i * 4
    luminance[i] =
      ((0.299 * pixels[offset] +
        0.587 * pixels[offset + 1] +
        0.114 * pixels[offset + 2]) *
        pixels[offset + 3]) /
      255
  }
  const weights = new Float32Array(size * size)
  const stride = size + 1
  const integral = new Float64Array(stride * stride)
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x,
        offset = i * 4
      const gx =
        -luminance[i - size - 1] -
        2 * luminance[i - 1] -
        luminance[i + size - 1] +
        luminance[i - size + 1] +
        2 * luminance[i + 1] +
        luminance[i + size + 1]
      const gy =
        -luminance[i - size - 1] -
        2 * luminance[i - size] -
        luminance[i - size + 1] +
        luminance[i + size - 1] +
        2 * luminance[i + size] +
        luminance[i + size + 1]
      const r = pixels[offset],
        g = pixels[offset + 1],
        b = pixels[offset + 2]
      const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / 255
      // Chroma ratios retain the same modest skin cue for light and dark tones.
      const skin =
        r > 16 && g / r > 0.35 && g / r < 0.95 && b / r > 0.2 && b / r < 0.85
      const detail = Math.hypot(gx, gy)
      // Upper subjects win close calls against clothing or foreground detail.
      // A strong subject elsewhere can still win; blank images stay centered.
      weights[i] =
        (detail *
          (1 + saturation * 0.2) *
          (skin ? 1.35 : 1) *
          (1 - (0.65 * y) / size) *
          (1 - 0.1 * Math.abs(x / size - 0.5)) *
          pixels[offset + 3]) /
        255
    }
  }
  for (let y = 0; y < size; y++) {
    let row = 0
    for (let x = 0; x < size; x++) {
      row += weights[y * size + x]
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row
    }
  }
  const span = Math.max(4, Math.round(size * 0.3))
  let best = 0,
    left = 0,
    top = 0
  for (let y = 0; y <= size - span; y += 2) {
    for (let x = 0; x <= size - span; x += 2) {
      const score =
        integral[(y + span) * stride + x + span] -
        integral[y * stride + x + span] -
        integral[(y + span) * stride + x] +
        integral[y * stride + x]
      if (score > best) {
        best = score
        left = x
        top = y
      }
    }
  }
  if (best < 1) return center
  let sum = 0,
    weightedX = 0,
    weightedY = 0
  for (let y = top; y < top + span; y++) {
    for (let x = left; x < left + span; x++) {
      const weight = weights[y * size + x]
      sum += weight
      weightedX += x * weight
      weightedY += y * weight
    }
  }
  return {
    x: Math.max(0.05, Math.min(0.95, weightedX / sum / size)),
    y: Math.max(0.05, Math.min(0.95, weightedY / sum / size)),
  }
}
