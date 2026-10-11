/** Feed identities remain exact; only their route representation changes. */
const MAX_FEED_BYTES = 16 * 1024
const MAX_TOKEN_LENGTH = Math.ceil(MAX_FEED_BYTES / 3) * 4
// Legacy base64 links can contain '/' inside the payload.
export const PODCAST_ROUTE = /^\/podcast\/(?<encoded>.*)$/

function validFeedUrl(feed: string): boolean {
  if (!feed || feed.length > MAX_FEED_BYTES || feed !== feed.trim() || /[\u0000-\u001f\u007f]/.test(feed) || /[\uD800-\uDFFF]/u.test(feed)) return false
  try {
    const parsed = new URL(feed)
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !!parsed.hostname
  } catch { return false }
}
function binary(bytes: Uint8Array): string {
  return Array.from(bytes, byte => String.fromCharCode(byte)).join("")
}

/** Null means the caller should show an invalid-link state, never navigate. */
export function podcastFeedPath(feed: string): string | null {
  if (!validFeedUrl(feed)) return null
  const bytes = new TextEncoder().encode(feed)
  if (bytes.length > MAX_FEED_BYTES) return null
  const token = btoa(binary(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `/podcast/u-${token}`
}

export function decodePodcastFeed(encoded: string | undefined): string | null {
  if (!encoded || encoded.length > MAX_TOKEN_LENGTH * 3 + 2) return null
  try {
    // Also accept old percent-escaped base64 links, without double decoding.
    const token = decodeURIComponent(encoded)
    const modern = token.startsWith("u-")
    const payload = modern ? token.slice(2) : token
    if (payload.length > MAX_TOKEN_LENGTH || !payload) return null
    if (modern ? !/^[A-Za-z0-9_-]+$/.test(payload) : !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null
    const standard = modern ? payload.replace(/-/g, "+").replace(/_/g, "/") : payload
    const decoded = atob(standard)
    // atob permits nonzero discarded bits. Reject those aliases and malformed
    // padding; unpadded legacy links remain compatible.
    const canonical = btoa(decoded)
    if (standard.replace(/=+$/, "") !== canonical.replace(/=+$/, "")) return null
    if (standard.includes("=") && standard !== canonical) return null
    if (decoded.length > MAX_FEED_BYTES) return null
    const feed = modern
      ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(decoded, char => char.charCodeAt(0)))
      : decoded // Old btoa(feed) stored Latin1, not UTF8.
    return validFeedUrl(feed) ? feed : null
  } catch { return null }
}
