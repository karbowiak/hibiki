/**
 * Unified image URL builder for the `image://` Tauri custom protocol.
 *
 * All images go through a single `image://` scheme with semantic entity paths:
 *
 *   image://localhost/artist/{id}?src=...&name=...
 *   image://localhost/album/{id}?src=...&artist=...&name=...
 *   image://localhost/track/{id}?src=...&artist=...&album=...
 *   image://localhost/playlist/{id}?src=...
 *
 * The Rust handler fetches `src`, falls back to Deezer/iTunes by `name` when
 * `src` fails. Native cache keys include the verified account/library scope.
 *
 * This module is backend-agnostic — each backend owns its own URL assembly
 * (see backends/plex/imageUrl.ts).
 */

import { IS_WINDOWS } from "./platform"

// Tauri v2: WebView2 on Windows serves custom protocols as http://{scheme}.localhost/
const IMAGE_BASE = IS_WINDOWS ? "http://image.localhost" : "image://localhost"

type EntityType = "artist" | "album" | "track" | "playlist"

/**
 * Build a semantic image URL for an entity.
 *
 * @param entityType  "artist" | "album" | "track" | "playlist"
 * @param entityId    Entity ID (e.g. "548757" for Plex, "dz-399" for Deezer)
 * @param sourceUrl   Raw HTTP URL to fetch (null = go straight to metadata fallback)
 * @param name        Entity name for Rust-side metadata fallback (artist name for artists, album name for albums)
 * @param artist      Artist name — used for album/track metadata fallback
 */
export function buildImageUrl(
  entityType: EntityType,
  entityId: string,
  sourceUrl: string | null | undefined,
  name?: string | null,
  artist?: string | null,
  scope?: string | null,
): string | null {
  if (!entityId) return null
  // Need at least a source URL or a name for fallback
  if (!sourceUrl && !name) return null

  const params = new URLSearchParams()
  if (sourceUrl) params.set("src", sourceUrl)
  if (name) params.set("name", name)
  if (artist) params.set("artist", artist)
  if (scope) params.set("scope", scope)

  return `${IMAGE_BASE}/${entityType}/${encodeURIComponent(entityId)}?${params.toString()}`
}

/**
 * Build an image URL for a one-off external image without entity context.
 * Used for hub mixes, composite images, or any URL that doesn't map to a
 * generic entity. The Rust handler proxies + caches with no metadata fallback.
 *
 * Returns null if sourceUrl is null/undefined/empty.
 */
export function buildExternalImageUrl(sourceUrl: string | null | undefined, scope?: string | null): string | null {
  if (!sourceUrl) return null
  const params = new URLSearchParams({src: sourceUrl})
  if (scope) params.set("scope", scope)
  return `${IMAGE_BASE}/ext/img?${params}`
}
