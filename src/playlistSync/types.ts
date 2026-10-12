/** Token-free account identity. A new authentication increments revision even for the same username. */
export interface PlaylistAccount {
  service: string
  user: string
  revision: string
}
export interface PlaylistTrack {
  /** Provider-local ID, never a cross-provider matching key. */
  id: string
  recordingMbid?: string | null
  title: string
  artist: string
  album?: string | null
  durationMs?: number | null
}
export interface PlaylistOccurrence {
  occurrenceId: string
  track: PlaylistTrack
}
export interface PlaylistSnapshot {
  account: PlaylistAccount
  id: string
  title: string
  items: readonly PlaylistOccurrence[]
}
export interface PlaylistCapabilities {
  read: boolean
  createCopy: boolean
  replace: boolean
  reason?: string
}
export interface PlaylistAdapter {
  capabilities: PlaylistCapabilities
  account(): Promise<PlaylistAccount>
  read(id: string): Promise<PlaylistSnapshot>
  /** One explicit create, never an implicit overwrite or automatic retry. */
  createCopy(
    title: string,
    tracks: readonly PlaylistTrack[],
    expectedAccount: PlaylistAccount
  ): Promise<{ id: string }>
}
export type MatchResult =
  | {
      status: "matched"
      track: PlaylistTrack
      by: "mbid" | "metadata" | "manual"
    }
  | { status: "missing" | "ambiguous"; candidates: readonly PlaylistTrack[] }
export interface PlaylistPlan {
  version: 1
  direction: "import" | "export"
  source: PlaylistSnapshot
  target: PlaylistAccount
  title: string
  rows: readonly {
    occurrenceId: string
    source: PlaylistTrack
    match: MatchResult
  }[]
  /** Exact content captured by preview; used to reject edits before admission. */
  sourceRevision: string
}
export interface PlaylistAttempt {
  id: string
  account: PlaylistAccount
  sourceAccount: PlaylistAccount
  sourcePlaylistId: string
  title: string
  createdAt: number
  state:
    | "admitting"
    | "created"
    | "verified"
    | "reconcile"
    | "cancelled"
    | "dismissed"
  dismissedAt?: number
  dismissalReason?: "manual-unknown-outcome"
  reviewedAccount?: PlaylistAccount
  destinationId?: string
  expectedTrackIds: readonly string[]
}
/** Saves must acknowledge durable retention; a failed save stops the write. */
export interface PlaylistAttemptJournal {
  save(attempt: PlaylistAttempt): Promise<void>
  list(): Promise<PlaylistAttempt[]>
}
export function sameAccount(a: PlaylistAccount, b: PlaylistAccount) {
  return (
    a.service === b.service && a.user === b.user && a.revision === b.revision
  )
}

export function samePlaylistIdentity(a: PlaylistAccount, b: PlaylistAccount) {
  return a.service === b.service && a.user === b.user
}
