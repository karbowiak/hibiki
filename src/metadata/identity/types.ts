import type { MetadataFields, MetadataIdentity } from "../core/types"
export type IdentityProvider = "musicbrainz" | "heya"
export type IdentityKind = "artist" | "album"
export interface IdentityAlias {
  name: string
  locale?: string
  type?: string
}
export interface IdentityArtistCredit {
  name: string
  mbid?: string
}
/** Search evidence is a candidate; only exact-ID detail can be applied. */
export interface MetadataIdentityCandidate {
  provider: IdentityProvider
  kind: IdentityKind
  id: string
  title: string
  artist: string
  aliases: IdentityAlias[]
  disambiguation?: string
  artistType?: string
  area?: string
  releaseDate?: string
  artistCredits: IdentityArtistCredit[]
  identifiers: {
    artistMbid?: string
    releaseGroupMbid?: string
    wikidataQid?: string
  }
  /** Opaque native service binding, never a credential fingerprint or URL. */
  connectionId?: string
}
export interface ReviewedMetadataIdentity {
  candidate: MetadataIdentityCandidate
  fields: Partial<MetadataFields>
  fieldOrigins?: Partial<Record<keyof MetadataFields, string>>
  reviewedAt: number
}
/** Original library identity always remains the snapshot/display identity. */
export interface MetadataIdentityResolution {
  original: MetadataIdentity
  choice: MetadataIdentityCandidate | null
  lookupArtist: string
  lookupTitle?: string
  artistMbid?: string
  releaseGroupMbid?: string
  heyaId?: string
  connectionId?: string
  lease: string
  ready: boolean
  blockedReason?: string
}
