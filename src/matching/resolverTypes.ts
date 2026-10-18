export interface MatchingIdentifier { scheme: string; value: string }
export interface MatchingChanges { revision: number; coverage: string; cursor: number; reset: boolean; changes: { sequence: number; kind: "artist" | "album" | "track"; id: number }[] }
export interface MatchingExample { kind: "album" | "track"; title: string; duration?: number | null; year?: number | null }
export interface MatchingSource {
  id: string
  kind: "artist" | "album" | "track"
  title: string
  artists: string[]
  identifiers: MatchingIdentifier[]
  album?: string | null
  duration?: number | null
  explicit?: boolean | null
  version?: string | null
  date?: string | null
  year?: number | null
  releaseType?: string | null
  catalog: MatchingExample[]
  trackList: MatchingExample[]
}
/** Identity evidence only. This is never a playback, offline or browse DTO. */
export interface MatchingRow extends Omit<MatchingSource, "id" | "catalog" | "trackList"> {
  id: number
  titleKey: string
  artistKey: string
  artistId?: number | null
  albumId?: number | null
  disc?: number | null
  track?: number | null
  revision: string
}
export interface MatchingResolution {
  sourceId: string
  status: "matched" | "ambiguous" | "candidate" | "missing" | "incomplete" | "stale" | "limited" | "provider-error"
  candidates: { row: MatchingRow; score: number; verified: boolean; evidence: string[] }[]
  selected: number | null
  recordingIdentity: string | null
  coverage: "complete" | "incomplete" | "stale"
  revision: number
  cached: boolean
  limited: boolean
}
