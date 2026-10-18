export async function artworkFile(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 10_000_000)
    throw Error("Choose a JPEG, PNG or WebP image under 10 MB.")
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 40_000_000) throw Error("Choose an image smaller than 40 megapixels.")
    const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext("2d")
    if (!context) throw Error("This image could not be prepared. Try another image.")
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL("image/jpeg", 0.88)
  } finally { URL.revokeObjectURL(url) }
}

