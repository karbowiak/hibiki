/** Match public enrichment to its requested album without erasing identity. */
const normalizedName = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase()
const normalizedAlbum = (value: string) => {
  const title = normalizedName(value), format = /^(.*) - (single|ep)$/.exec(title)
  return format ? { title: format[1], format: format[2] } : { title, format: null }
}

export function albumMatches(data: unknown, artist: string, album: string): boolean {
  if (!data || typeof data !== "object") return false
  const identity = data as { artist?: unknown; title?: unknown }
  const requestedArtist = normalizedName(artist), requestedAlbum = normalizedAlbum(album)
  if (!requestedArtist || !requestedAlbum.title || typeof identity.artist !== "string" || typeof identity.title !== "string") return false
  const returnedAlbum = normalizedAlbum(identity.title)
  return requestedArtist === normalizedName(identity.artist) && requestedAlbum.title === returnedAlbum.title
    && (!requestedAlbum.format || !returnedAlbum.format || requestedAlbum.format === returnedAlbum.format)
}

/** Legacy keys use ::; the returned artist identifies its boundary, even when
 * names contain ::. Normalize once so long names never cause quadratic scans. */
export function albumMatchesCacheKey(data: unknown, key: string): boolean {
  if (!data || typeof data !== "object" || typeof (data as { artist?: unknown }).artist !== "string") return false
  const artist = normalizedName((data as { artist: string }).artist), normalizedKey = normalizedName(key)
  if (!artist || !normalizedKey.startsWith(artist)) return false
  const remainder = normalizedKey.slice(artist.length).trimStart()
  return remainder.startsWith("::") && albumMatches(data, artist, remainder.slice(2))
}
