/**
 * Plex-specific image URL assembly.
 *
 * Assembles a token-free source URL, with an opaque account/library scope, in the
 * semantic `image://` scheme via the shared buildImageUrl().
 */

import { buildImageUrl, buildExternalImageUrl } from "../../lib/imageUrl"

type EntityType = "artist" | "album" | "track" | "playlist"

function artworkSource(baseUrl: string, path: string): string | null {
  const absolute = /^https?:\/\//i.test(path)
    ? path
    : `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
  try {
    const url = new URL(absolute)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null
    if (![...url.searchParams.keys()].some((key) => key.toLowerCase() === "x-plex-token")) return absolute
    const filtered = url.search
      .slice(1)
      .split("&")
      .filter((pair) => [...new URLSearchParams(pair).keys()][0]?.toLowerCase() !== "x-plex-token")
      .join("&")
    // Preserve signed query bytes that do not belong to Plex credentials.
    url.search = filtered ? `?${filtered}` : ""
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Build a semantic image URL for a Plex entity.
 *
 * @param baseUrl     Plex server base URL
 * @param token       Plex auth token
 * @param entityType  "artist" | "album" | "track" | "playlist"
 * @param entityId    Plex rating_key as string
 * @param thumbPath   Plex thumb path (e.g. "/library/metadata/548757/thumb/1234567890")
 * @param name        Entity name for metadata fallback
 * @param artist      Artist name for album/track metadata fallback
 */
export function buildPlexImageUrl(
  baseUrl: string,
  token: string,
  entityType: EntityType,
  entityId: string,
  thumbPath: string,
  name?: string | null,
  artist?: string | null,
  scope?: string | null
): string | null {
  if (!baseUrl || !token || !thumbPath) return null
  const source = artworkSource(baseUrl, thumbPath)
  return buildImageUrl(entityType, entityId, source, name, artist, scope)
}

/**
 * Build an image URL for Plex resources that don't map to a generic entity
 * (hub mixes, composite playlist thumbs when we don't have the playlist ID, etc.).
 */
export function buildPlexExternalImageUrl(
  baseUrl: string,
  token: string,
  thumbPath: string,
  scope?: string | null
): string | null {
  if (!baseUrl || !token || !thumbPath) return null
  return buildExternalImageUrl(artworkSource(baseUrl, thumbPath), scope)
}
