import { invoke } from "@tauri-apps/api/core"
import type {
  IdentityKind,
  MetadataIdentityCandidate,
  ReviewedMetadataIdentity,
} from "./types"
export const searchMusicBrainzIdentities = (
  kind: IdentityKind,
  artist: string,
  title?: string,
  query?: string
): Promise<MetadataIdentityCandidate[]> =>
  invoke("musicbrainz_search_identities", {
    kind,
    artist,
    title: title ?? null,
    query: query ?? null,
  })
export const reviewMusicBrainzIdentity = (
  kind: IdentityKind,
  id: string
): Promise<ReviewedMetadataIdentity> =>
  invoke("musicbrainz_review_identity", { kind, id })
export const searchHeyaIdentities = (
  revision: string,
  kind: IdentityKind,
  query: string
): Promise<MetadataIdentityCandidate[]> =>
  invoke("heya_search_identities", { revision, kind, query })
export const reviewHeyaIdentity = (
  revision: string,
  kind: IdentityKind,
  id: string
): Promise<ReviewedMetadataIdentity> =>
  invoke("heya_review_identity", { revision, kind, id })
