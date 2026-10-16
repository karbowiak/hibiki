/** Explain recognized failures without displaying URLs, credentials or upstream bodies. */
function superseded(error: unknown) {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ""
  return /^(?:Error:\s*)?(?:Metadata request was superseded|Saved library request was superseded|Plex (?:connection|music library) was superseded|Native owner retired)\b/i.test(
    text
  )
}

/** A live page can lose a read to cache invalidation. Restart it once, without
 * retrying server failures or sending another request for a retired page. */
export async function retryMetadataRefresh<T>(
  request: () => Promise<T>,
  current: () => boolean
): Promise<T> {
  try {
    return await request()
  } catch (error) {
    if (current() && superseded(error)) return request()
    throw error
  }
}

export function metadataRefreshMessage(
  error: unknown,
  item: "artist" | "album"
): string | null {
  const text = (
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ""
  ).toLowerCase()
  if (superseded(error)) return null
  const saved = `Showing saved ${item} information.`
  if (/\b(401|403)\b|unauthorized|forbidden/.test(text))
    return `${saved} Plex denied access. Check your account and selected library in Connection settings.`
  if (/\b404\b|artist not found|album not found/.test(text))
    return `${saved} This ${item} is no longer available at its saved Plex location. Refresh your library to find its current entry.`
  if (/timed?\s*out|timeout/.test(text))
    return `${saved} Plex took too long to answer. Try again in a moment.`
  if (/\b429\b/.test(text))
    return `${saved} Plex is limiting requests. Wait a moment before trying again.`
  if (/parse|deserializ|invalid.*metadata|different (artist|album)/.test(text))
    return `${saved} Plex returned information Hibiki couldn't read. Try refreshing again.`
  if (/\b50[0-4]\b/.test(text))
    return `${saved} Plex couldn't complete the request. Try again in a moment.`
  return `${saved} Hibiki couldn't refresh all the Plex data for this page. Try again.`
}
