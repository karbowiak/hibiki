import type { MetadataSource } from "../../stores/metadataSourceStore"

export type MetadataProviderSource = MetadataSource | "soulsync"

export type MetadataKind = "artist" | "album" | "track"
export interface MetadataIdentity {
  kind: MetadataKind
  artist: string
  title?: string
  /** Library identity is scoped; names remain required for public matching. */
  entityId?: string
  scope: string
}
export interface MetadataFields {
  title: string
  artist: string
  description: string
  biography: string
  summary: string
  artwork: string
  genres: string[]
  tags: string[]
  releaseDate: string
  label: string
  fans: number
  listeners: number
  playCount: number
  trackCount: number
  mbid: string
  artistType: string
  area: string
  beginDate: string
  wikipediaUrl: string
  externalUrl: string
  similarArtists: { name: string; url: string; image: string | null }[]
}
export type MetadataField = keyof MetadataFields
/** Confidence is evidence, never an invented numeric search score. */
export interface MetadataMatch {
  kind: "library" | "exact-name" | "candidate"
  reason: string
}
export interface MetadataSnapshot {
  source: MetadataProviderSource
  identity: MetadataIdentity
  fields: Partial<MetadataFields>
  match: MetadataMatch
  /** Time this snapshot was assembled, not a claim about upstream freshness. */
  observedAt: number
  fieldOrigins?: Partial<Record<MetadataField, string>>
}
export type MetadataResult =
  | { status: "ready"; snapshot: MetadataSnapshot }
  | { status: "unsupported" | "unavailable" | "retired" }
  | {
      status: "ambiguous"
      reason: string
      candidates: { id: string; name: string }[]
    }
  | { status: "error"; code: "lookup-failed" | "queue-full"; retryable: true }
export interface MetadataAdapter {
  id: MetadataProviderSource
  fields: Partial<Record<MetadataKind, readonly MetadataField[]>>
  /** Public API budget; actual HTTP scheduling remains in its existing transport. */
  transportPolicy: string
  lookup(identity: MetadataIdentity): Promise<MetadataResult>
  invalidate?(identity: MetadataIdentity): void
}
export interface MetadataSelection {
  scope: string
  identityKey: string
  source?: MetadataProviderSource
  fields?: Partial<Record<MetadataField, MetadataProviderSource>>
}
export interface ResolvedMetadataField<
  K extends MetadataField = MetadataField,
> {
  value: MetadataFields[K]
  source: MetadataProviderSource
  match: MetadataMatch
  observedAt: number
  origin?: string
  fallback: boolean
}
