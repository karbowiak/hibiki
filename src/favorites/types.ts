import type { MusicTrack } from "../types/music"
import type { PlaylistAccount } from "../playlistSync/types"
export type FavoriteService = "plex" | "lastfm" | "listenbrainz"
export interface FavoriteRecording {
  key: string
  title: string
  artist: string
  album?: string
  durationMs?: number | null
  localTrackId?: string | null
  /** Actual love time in Unix milliseconds; missing service dates remain unknown. */
  likedAt?: number | null
  recordingMbid?: string | null
  recordingMsid?: string | null
}
export interface FavoriteEntry extends FavoriteRecording {
  id: string
  liked: boolean
  explicit: boolean
  localTrackIds: string[]
  sources: Partial<
    Record<
      FavoriteService,
      {
        key: string
        liked: boolean
        desired?: boolean
        likedAt?: number | null
      }
    >
  >
  changedAt: number
  /** A deliberate star edit; imported likes only derive their display rating. */
  rating?: import("./ratings").FavoriteRatingIntent
  matchCheckedAt?: number
}
export interface FavoritePending {
  id: string
  entryId: string
  entryIds?: string[]
  recording: FavoriteRecording
  liked: boolean
  before: boolean
  state: "admitting" | "unknown"
  beforeHash?: string
  afterHash?: string
  operation?:
    { kind: "append"; ids: string[] } | { kind: "delete"; index: number }
}
export interface FavoriteBinding {
  account: PlaylistAccount
  initialized: boolean
  playlistId?: string
  creation?: {
    state: "admitting" | "unknown" | "created"
    destinationId?: string
  }
  pending?: FavoritePending
}
export interface FavoriteMetadata {
  version: 1
  settings: Record<FavoriteService, boolean> & { ratingThreshold: number }
  bindings: Partial<Record<FavoriteService, FavoriteBinding>>
  ratingsImported?: boolean
  ratingModel?: 1
}
export interface FavoriteState extends FavoriteMetadata {
  revision: number
  entries: Record<string, FavoriteEntry>
}
export interface FavoritePage {
  rows: FavoriteRecording[]
  total: number
  offset: number
}
export interface FavoritePlexSnapshot extends FavoritePage {
  title: string
  items: { trackId: string; occurrenceId: string }[]
}
export interface FavoritesNative {
  cachedTracks?(ids: string[]): Promise<MusicTrack[]>
  load(): Promise<{
    revision: number
    metadata: FavoriteMetadata
    total: number
  }>
  page(
    offset: number,
    limit: number
  ): Promise<{ id: string; payload: FavoriteEntry }[]>
  save(
    expected: number,
    metadata: FavoriteMetadata,
    rows: { id: string; payload: FavoriteEntry }[]
  ): Promise<number>
  reset(expected: number): Promise<number>
  plexRead(id: string): Promise<FavoritePlexSnapshot>
  plexMutate(
    id: string,
    beforeHash: string,
    operation: NonNullable<FavoritePending["operation"]>
  ): Promise<FavoritePlexSnapshot>
}
export interface FavoriteRepository {
  read(): FavoriteState
  update(
    change: (state: FavoriteState) => FavoriteState
  ): Promise<FavoriteState>
}
export function favoriteReference(track: MusicTrack): FavoriteRecording {
  return {
    key: `local:${track.id}`,
    localTrackId: track.id,
    title: track.title,
    artist: track.originalTitle?.trim() || track.artistName,
    album: track.albumName,
    durationMs: track.duration,
  }
}
