/** Cover geometry shared by sharp artwork and its blurred continuation. */
export function artworkPlacement(
  width: number,
  height: number,
  imageWidth: number,
  imageHeight: number,
  x = 0.5,
  y = 0.5
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
  return {
    width: renderedWidth,
    height: renderedHeight,
    left: (width - renderedWidth) * clamp(x),
    top: (height - renderedHeight) * clamp(y),
  }
}
