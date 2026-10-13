import { soulSyncArtist, soulSyncEntity } from "./api"
import type { MetadataAdapter } from "../core/types"
import type { SoulSyncStatus, SoulSyncArtist, SoulSyncLookup } from "./api"
export function nativeSoulSyncAdapter(
  status: SoulSyncStatus | null,
  getStatus: () => SoulSyncStatus | null,
  lookup: (
    revision: string,
    artist: string
  ) => Promise<SoulSyncArtist | SoulSyncLookup | null> = soulSyncArtist,
  lookupEntity: typeof soulSyncEntity = soulSyncEntity
): MetadataAdapter {
  return {
    id: "soulsync",
    fields: {
      album: [
        "summary",
        "genres",
        "tags",
        "listeners",
        "playCount",
        "label",
        "mbid",
        "releaseDate",
        "trackCount",
      ],
      track: ["summary", "tags", "listeners", "playCount", "mbid"],
      artist: [
        "biography",
        "artwork",
        "genres",
        "tags",
        "listeners",
        "playCount",
        "label",
        "mbid",
      ],
    },
    // Native lookups have no byte/field cache; refresh retires only this client snapshot.
    invalidate() {},
    transportPolicy:
      "Native credential storage and shared 1 request/second GET-only transport.",
    async lookup(identity) {
      if (!status?.enabled || !status.configured)
        return { status: "unavailable" }
      if (getStatus()?.revision !== status.revision)
        return { status: "retired" }
      if (identity.kind !== "artist") {
        const response = await lookupEntity(
          status.revision,
          identity.kind,
          identity.artist,
          identity.title ?? ""
        )
        if (getStatus()?.revision !== status.revision)
          return { status: "retired" }
        if (response.status === "ambiguous")
          return {
            status: "ambiguous",
            candidates: response.candidates,
            reason:
              "Several SoulSync library records share this exact artist/title; no record was chosen.",
          }
        if (response.status !== "ready") return { status: "unavailable" }
        if (
          response.item.artist.trim().toLowerCase() !==
            identity.artist.trim().toLowerCase() ||
          response.item.title.trim().toLowerCase() !==
            identity.title?.trim().toLowerCase()
        )
          return { status: "unavailable" }
        return {
          status: "ready",
          snapshot: {
            source: "soulsync",
            identity: { ...identity },
            fields: response.item.fields,
            fieldOrigins: response.item.fieldOrigins,
            match: {
              kind: "exact-name",
              reason:
                "Unique exact artist/title library record and detail artist ownership verified.",
            },
            observedAt: Date.now(),
          },
        }
      }
      const response = await lookup(status.revision, identity.artist)
      if (getStatus()?.revision !== status.revision)
        return { status: "retired" }
      if (!response) return { status: "unavailable" }
      if ("status" in response && response.status === "ambiguous")
        return {
          status: "ambiguous",
          candidates: response.candidates,
          reason:
            "Several SoulSync library artists share this name; no record was chosen automatically.",
        }
      if ("status" in response && response.status === "unavailable")
        return { status: "unavailable" }
      const data = "status" in response ? response.artist : response
      return {
        status: "ready",
        snapshot: {
          source: "soulsync",
          identity: { ...identity },
          fields: {
            biography: data.summary ?? undefined,
            artwork: data.thumbUrl ?? undefined,
            genres: data.genres,
            tags: data.tags,
            listeners: data.listeners ?? undefined,
            playCount: data.playCount ?? undefined,
            label: data.label ?? undefined,
            mbid: data.mbid ?? undefined,
          },
          fieldOrigins: {
            biography: data.summaryOrigin ?? "SoulSync library",
            tags: "Last.fm via SoulSync",
            listeners: "Last.fm via SoulSync",
            playCount: "Last.fm via SoulSync",
          },
          match: {
            kind: "exact-name",
            reason:
              "Unique exact-name supported SoulSync REST library record; metadata-only aliases are not merged into this record.",
          },
          observedAt: Date.now(),
        },
      }
    },
  }
}
