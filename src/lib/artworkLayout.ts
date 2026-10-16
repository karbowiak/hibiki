/** Minimum cover scale shared by sharp artwork and its blurred continuation.
 * x/y are source-image focal coordinates, not CSS alignment percentages.
 * The image covers the full client; focusHeight may favor its sharp hero band
 * when spare pixels allow repositioning. It never changes the scale. */
export function artworkPlacement(
  width: number,
  height: number,
  imageWidth: number,
  imageHeight: number,
  x = 0.5,
  y = 0.5,
  focusHeight = height
) {
  if (
    ![width, height, imageWidth, imageHeight].every(
      (value) => Number.isFinite(value) && value > 0
    )
  )
    return null
  const scale = Math.max(width / imageWidth, height / imageHeight)
  const renderedWidth = imageWidth * scale,
    renderedHeight = imageHeight * scale
  const clamp = (value: number) =>
    Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5
  const focusBand = Number.isFinite(focusHeight)
    ? Math.max(1, Math.min(height, focusHeight))
    : height
  return {
    width: renderedWidth,
    height: renderedHeight,
    left: Math.min(
      0,
      Math.max(width - renderedWidth, width / 2 - renderedWidth * clamp(x))
    ),
    top: Math.min(
      0,
      Math.max(
        height - renderedHeight,
        focusBand / 2 - renderedHeight * clamp(y)
      )
    ),
  }
}
