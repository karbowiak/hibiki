import { invoke } from "@tauri-apps/api/core"
import { useMusicBrainzMetadataStore } from "../musicbrainz/store"
import type {
  MetadataAdapter,
  MetadataFields,
  MetadataField,
} from "../core/types"
import type { ProviderArtworkCandidate } from "../services/api"
import type { MetadataServiceStatus } from "../services/api"
export interface HeyaItem {
  posters: ProviderArtworkCandidate[]
  backgrounds: ProviderArtworkCandidate[]
  id: string
  artist: string
  title: string | null
  fields: Partial<MetadataFields>
  fieldOrigins: Partial<Record<MetadataField, string>>
  revision: string
}
export type HeyaLookup =
  | { status: "ready"; item: HeyaItem }
  | { status: "unavailable" }
  | { status: "ambiguous"; candidates: { id: string; name: string }[] }
export function nativeHeyaAdapter(
  status: MetadataServiceStatus | null,
  getStatus: () => MetadataServiceStatus | null
): MetadataAdapter {
  return {
    id: "heya",
    fields: {
      artist: ["biography", "genres", "tags", "artistType"],
      album: ["summary", "genres", "tags", "releaseDate"],
    },
    transportPolicy:
      "Explicitly configured native GET-only canonical search/detail, bounded response/admission and shared 1 request/sec gate; normal server stale-read refresh may occur.",
    invalidate() {},
    lookup: async (identity) => {
      if (identity.kind === "track") return { status: "unsupported" }
      if (!status?.enabled || !status.configured)
        return { status: "unavailable" }
      if (getStatus()?.revision !== status.revision)
        return { status: "retired" }
      let match =
        identity.kind === "artist"
          ? await useMusicBrainzMetadataStore
              .getState()
              .getArtist(identity.artist)
          : await useMusicBrainzMetadataStore
              .getState()
              .getAlbum(identity.artist, identity.title ?? "")
      if (identity.kind === "artist" && match && !("wikidata_url" in match)) {
        useMusicBrainzMetadataStore.getState().invalidateArtist(identity.artist)
        match = await useMusicBrainzMetadataStore
          .getState()
          .getArtist(identity.artist)
      }
      if (getStatus()?.revision !== status.revision)
        return { status: "retired" }
      const result = await invoke<HeyaLookup>("heya_get_metadata", {
        revision: status.revision,
        kind: identity.kind,
        artist: identity.artist,
        title: identity.title ?? null,
        mbid: match?.mbid ?? null,
      })
      if (getStatus()?.revision !== status.revision)
        return { status: "retired" }
      if (result.status === "ambiguous")
        return {
          status: "ambiguous",
          candidates: result.candidates,
          reason:
            "Multiple HeyaMetadata canonical records match this identity; no record was chosen.",
        }
      if (result.status !== "ready") return { status: "unavailable" }
      if (
        result.item.revision !== status.revision ||
        result.item.artist.trim().toLowerCase() !==
          identity.artist.trim().toLowerCase() ||
        (identity.kind === "album" &&
          result.item.title?.trim().toLowerCase() !==
            identity.title?.trim().toLowerCase())
      )
        return { status: "unavailable" }
      return {
        status: "ready",
        snapshot: {
          source: "heya",
          identity: { ...identity },
          fields: result.item.fields,
          fieldOrigins: result.item.fieldOrigins,
          observedAt: Date.now(),
          match: {
            kind: "exact-name",
            reason: match?.mbid
              ? "MusicBrainz identifier verified in unique HeyaMetadata search and canonical detail."
              : "Unique exact artist/title identity verified in HeyaMetadata search and canonical detail.",
          },
        },
      }
    },
  }
}
