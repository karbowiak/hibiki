import type { MetadataAdapter, MetadataResult } from "./types"
/** Explicit optional configuration only. Keys stay in the caller's credential
 * transport; no discovery, bootstrap, local config reads or writes. */
export interface SoulSyncConfiguration {
  baseUrl: string
  getApiKey(): string | null
}
export interface SoulSyncReadRequest {
  method: "GET"
  url: string
  headers: Record<string, string>
  redirect: "error"
  maxBytes: number
}
export type SoulSyncReadTransport = (
  request: SoulSyncReadRequest
) => Promise<{ status: number; finalUrl: string; body: unknown }>
const normalized = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLowerCase()
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : undefined
const detailId = (value: unknown): string | null => {
  const text =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : ""
  if (!/^[1-9]\d{0,18}$/.test(text)) return null
  try {
    return BigInt(text) <= 9223372036854775807n ? text : null
  } catch {
    return null
  }
}
/** Verified upstream GET artist search/detail routes. Albums/tracks remain
 * unsupported until their identity mapping is integrated; no invented IDs. */
export function createSoulSyncAdapter(
  config: SoulSyncConfiguration,
  transport: SoulSyncReadTransport
): MetadataAdapter {
  const base = new URL(config.baseUrl)
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error("SoulSync requires a plain HTTP(S) server URL.")
  base.pathname = base.pathname.replace(/\/+$/, "") + "/"
  let nextRequest = 0,
    chain: Promise<unknown> = Promise.resolve()
  const get = (
    path: string,
    query: Record<string, string>,
    key: string
  ): Promise<Record<string, unknown> | null> => {
    const operation = chain
      .catch(() => {})
      .then(async () => {
        if (config.getApiKey() !== key) return null
        const delay = Math.max(0, nextRequest - Date.now())
        if (delay) await new Promise((done) => setTimeout(done, delay))
        if (config.getApiKey() !== key) return null
        nextRequest = Date.now() + 1000 // documented 60/min source budget
        const url = new URL(path, base)
        for (const [name, value] of Object.entries(query))
          url.searchParams.set(name, value)
        const response = await transport({
          method: "GET",
          url: url.href,
          headers: { Authorization: `Bearer ${key}` },
          redirect: "error",
          maxBytes: 1024 * 1024,
        })
        if (config.getApiKey() !== key) return null
        if (
          response.status < 200 ||
          response.status >= 300 ||
          response.finalUrl !== url.href
        )
          throw Error("SoulSync lookup failed.")
        if (JSON.stringify(response.body).length > 1024 * 1024)
          throw Error("SoulSync response exceeds metadata bounds.")
        const envelope = object(response.body)
        if (envelope?.success !== true || !object(envelope.data))
          throw Error("SoulSync returned an invalid metadata response.")
        const data = object(envelope.data)!
        if (path === "api/v1/library/artists") {
          const pagination = object(envelope.pagination)
          return {
            ...data,
            _boundedSearchIncomplete:
              pagination?.has_next === true ||
              (typeof pagination?.total === "number" &&
                Array.isArray(data.artists) &&
                pagination.total > data.artists.length),
          }
        }
        return data
      })
    chain = operation
    return operation
  }
  return {
    id: "soulsync",
    fields: { artist: ["biography", "artwork", "genres", "label", "mbid"] },
    invalidate() {},
    transportPolicy:
      "Optional configured Bearer service; GET-only, no redirects, 1 request/second, bounded replies.",
    async lookup(identity): Promise<MetadataResult> {
      if (identity.kind !== "artist") return { status: "unsupported" }
      const key = config.getApiKey()
      if (!key) return { status: "unavailable" }
      const listing = await get(
        "api/v1/library/artists",
        { search: identity.artist, page: "1", limit: "5", fields: "id,name" },
        key
      )
      if (!listing) return { status: "retired" }
      if (
        listing._boundedSearchIncomplete ||
        !Array.isArray(listing.artists) ||
        listing.artists.length > 5
      )
        return { status: "unavailable" }
      const matches = listing.artists
        .map(object)
        .filter(
          (item) =>
            item &&
            typeof item.name === "string" &&
            normalized(item.name) === normalized(identity.artist) &&
            detailId(item.id) !== null
        )
      if (matches.length > 1)
        return {
          status: "ambiguous",
          reason:
            "Several supported SoulSync library artists share this name; no record was selected automatically.",
          candidates: matches.map((item) => ({
            id: detailId(item!.id)!,
            name: String(item!.name),
          })),
        }
      if (!matches.length) return { status: "unavailable" }
      const id = detailId(matches[0]!.id)!
      const detail = await get(
        `api/v1/library/artists/${encodeURIComponent(id)}`,
        { fields: "id,name,summary,thumb_url,genres,label,musicbrainz_id" },
        key
      )
      if (!detail) return { status: "retired" }
      const artist = object(detail.artist)
      if (
        !artist ||
        detailId(artist.id) !== id ||
        typeof artist.name !== "string" ||
        normalized(artist.name) !== normalized(identity.artist)
      )
        return { status: "unavailable" }
      const image = text(artist.thumb_url)
      let artwork: string | undefined
      if (image) {
        try {
          const url = new URL(image)
          if (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          )
            artwork = image
        } catch {
          /* Missing/relative/private image references are not exposed. */
        }
      }
      const genres = Array.isArray(artist.genres)
        ? artist.genres
            .filter((value): value is string => typeof value === "string")
            .slice(0, 64)
        : undefined
      return {
        status: "ready",
        snapshot: {
          source: "soulsync",
          identity: { ...identity },
          fields: {
            biography: text(artist.summary),
            artwork,
            genres,
            label: text(artist.label),
            mbid: text(artist.musicbrainz_id),
          },
          match: {
            kind: "exact-name",
            reason:
              "Unique exact-name SoulSync library match; aggregate field provenance remains SoulSync, not an inferred upstream provider.",
          },
          observedAt: Date.now(),
        },
      }
    },
  }
}
