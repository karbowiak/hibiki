/**
 * Music provider abstraction layer.
 *
 * Components and stores talk to this interface — only concrete providers
 * (PlexProvider, etc.) know about backend-specific field names and API calls.
 */

import type {
  MusicTrack,
  MusicAlbum,
  MusicArtist,
  MusicPlaylist,
  MusicItem,
  MusicHub,
  PagedResult,
} from "../types/music"

export interface LibraryMetadataPatch {
  title?: string
  summary?: string
  sortTitle?: string
  releaseDate?: string
}
export type LibraryMetadataExpected = Partial<
  Record<keyof LibraryMetadataPatch, string | null>
>
export interface LibraryArtworkInventory {
  baseline: string
  candidates: {
    id: string
    sourceUrl: string | null
    label: string
    selected: boolean
  }[]
}

export interface PlaylistOccurrenceState {
  title: string
  items: { trackId: string; occurrenceId: string }[]
}
export type PlaylistOccurrenceMutation =
  | { kind: "append"; trackId: string }
  | { kind: "move"; from: number; to: number }
  | { kind: "delete"; index: number }

export interface ProviderCapabilities {
  search: boolean
  playlists: boolean
  playlistEdit: boolean
  /** Transport availability; actual server edit permission is checked on Save. */
  metadataEdit?: boolean
  ratings: boolean
  radio: boolean
  sonicSimilarity: boolean
  djModes: boolean
  playQueues: boolean
  lyrics: boolean
  streamLevels: boolean
  hubs: boolean
  stations: boolean
  tags: boolean
  scrobble: boolean
  mixTracks: boolean
  browseArtists: boolean
  browseAlbums: boolean
  browseTracks: boolean
  syncArtists: boolean
  syncAlbums: boolean
  syncTracks: boolean
}

/** Everything the audio engine needs to play or preload a track. */
export interface TrackPlaybackInfo {
  /** Native ownership for authenticated Plex audio; absent for public streams. */
  plexContext?: { connectionRevision: number; cacheScope: string }
  url: string
  /** Numeric key for the audio engine's internal tracking / dedup. */
  trackKey: number
  /** Media part ID — used for stream levels. 0 if not applicable. */
  partId: number
  /** Parent key — used for same-album crossfade detection. Empty if not applicable. */
  parentKey: string
  /** Loudness ramp from track start (dB/time pairs, semicolon-delimited) */
  startRamp: string | null
  /** Loudness ramp from track end (dB/time pairs, semicolon-delimited) */
  endRamp: string | null
  /** Fresh Plex loudness values obtained during native playback preparation. */
  trackGain?: number | null
  albumGain?: number | null
}

export interface LevelData {
  loudness: number
}

export interface LyricLineData {
  startMs: number
  endMs: number
  text: string
}

export interface LyricsSource {
  id: string // "plex" | "genius-{songId}"
  label: string // "Plex" | song title from Genius
  lines: LyricLineData[]
  isSynced: boolean // true=timed (Plex), false=plain (Genius)
}

export interface PlaylistRecordingTrack {
  id: string
  title: string
  artist: string
  album?: string | null
  durationMs?: number | null
}
export type PlaylistRecordingResolution =
  | {
      status: "verified"
      recordingMbid: string
      proof: "explicit-recording-guid" | "release-track-relationship"
      metadataFingerprint: string
    }
  | { status: "unmatched" | "unavailable"; reason: string }
export interface MusicProvider {
  /** Scoped local favorite persistence and optional Plex membership mirroring. */
  readonly favorites?: import("../favorites/types").FavoritesNative
  /** Cached-library browsing does not claim a live server connection. */
  readonly isOffline?: boolean
  /** Runtime identity changes when this provider revokes or replaces its connection. */
  readonly playbackSession?: unknown
  readonly name: string
  readonly capabilities: ProviderCapabilities
  /** Opaque account/server/library digest. Null disables persistent provider caches. */
  readonly cacheScope?: string | null
  /** Explicit collection caches, warmed independently of the full Plex catalogue. */
  warmCollections?(): void
  stopCollectionWarmup?(): void
  getCachedTrackSource?(key: string, shuffle?: boolean): Promise<import("../lib/pagedPlayback").PagedTrackSource | null>
  readonly savedQueue?: import("../lib/queueSession").SavedQueueStorage
  getCollectionPage?(key: string, offset: number, limit: number, filter: string, sort: string, dir: "asc" | "desc"): Promise<PagedResult<MusicItem>>

  // --- Connection ---
  connect(config: Record<string, unknown>): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean

  /** Native-owned audio; availability is checked against actual complete files. */
  getLocalAudio?(
    offset?: number,
    limit?: number,
    cached?: boolean
  ): Promise<import("../offline/audio").LocalAudioPage>
  downloadTracks?(ids: string[]): Promise<void>
  removeDownload?(id: string): Promise<void>
  resumeDownloads?(): Promise<void>

  // --- Browse ---
  search(
    query: string,
    type?: "track" | "album" | "artist"
  ): Promise<MusicItem[]>
  /** Bounded scoped discovery only; returned metadata does not establish recording identity. */
  findPlaylistCandidates?(
    track: PlaylistRecordingTrack & { recordingMbid?: string | null }
  ): Promise<{ tracks: MusicTrack[]; truncated: boolean; unavailable: boolean }>
  getRecentlyAdded(type?: string, limit?: number): Promise<MusicItem[]>
  /** Albums ordered by original release date, independently of library import date. */
  getLatestReleases?(limit?: number): Promise<MusicAlbum[]>
  getHubs(): Promise<MusicHub[]>

  // --- Library ---
  getTrack(id: string): Promise<MusicTrack>
  getAlbum(id: string): Promise<MusicAlbum>
  getArtist(id: string): Promise<MusicArtist>
  editMetadata?(
    kind: "artist" | "album",
    itemId: string,
    patch: LibraryMetadataPatch,
    expected: LibraryMetadataExpected
  ): Promise<void>
  getAdvancedMetadata?(
    kind: "artist" | "album",
    itemId: string
  ): Promise<import("../lib/metadataAdvanced").AdvancedMetadata>
  editAdvancedMetadata?(
    kind: "artist" | "album",
    itemId: string,
    patch: import("../lib/metadataAdvanced").AdvancedMetadataPatch
  ): Promise<void>
  getArtworkInventory?(
    kind: "artist" | "album",
    itemId: string,
    role: "poster" | "background"
  ): Promise<LibraryArtworkInventory>
  saveArtwork?(
    kind: "artist" | "album",
    itemId: string,
    role: "poster" | "background",
    baseline: string,
    change: { choice: string } | { upload: number[] }
  ): Promise<LibraryArtworkInventory>
  getAlbumTracks(albumId: string): Promise<MusicTrack[]>
  /** Complete known artist discography; offline callers filter native file availability. */
  getArtistTracks?(artistId: string): Promise<MusicTrack[]>
  getArtistAlbums(
    artistId: string,
    formatFilter?: string
  ): Promise<MusicAlbum[]>
  getArtistPopularTracks(
    artistId: string,
    limit?: number
  ): Promise<MusicTrack[]>
  getArtistSimilar(artistId: string): Promise<MusicArtist[]>
  getRelatedHubs(itemId: string): Promise<MusicHub[]>

  // --- Playlists ---
  getPlaylists(): Promise<MusicPlaylist[]>
  getPlaylistItems(
    playlistId: string,
    offset?: number,
    limit?: number
  ): Promise<PagedResult<MusicTrack>>
  createPlaylist(title: string, itemIds: string[]): Promise<MusicPlaylist>
  /** One preflighted, non-retrying occurrence mutation for explicitly linked sync. */
  mutatePlaylistOccurrence?(
    playlistId: string,
    expected: PlaylistOccurrenceState,
    operation: PlaylistOccurrenceMutation
  ): Promise<PlaylistOccurrenceState>
  /** Read-only exact-ID resolution, only after explicit selected-playlist review. */
  resolvePlaylistRecording?(
    track: PlaylistRecordingTrack
  ): Promise<PlaylistRecordingResolution>
  /** One owned, preflighted description save with fresh post-read proof. */
  describePlaylist?(
    playlistId: string,
    expected: PlaylistOccurrenceState,
    expectedDescription: string,
    description: string
  ): Promise<string>
  addToPlaylist(playlistId: string, itemIds: string[]): Promise<void>
  removeFromPlaylist(
    playlistId: string,
    playlistItemIds: string[]
  ): Promise<void>
  deletePlaylist(playlistId: string): Promise<void>
  editPlaylist(
    playlistId: string,
    title?: string,
    summary?: string
  ): Promise<void>
  movePlaylistItem(
    playlistId: string,
    itemId: string,
    afterItemId: string
  ): Promise<void>

  // --- Liked ---
  getRatedItemsPage?(kind: "track" | "album" | "artist", offset: number, limit: number): Promise<PagedResult<MusicItem>>
  getLikedTracks(limit?: number): Promise<MusicTrack[]>
  getLikedAlbums(limit?: number): Promise<MusicAlbum[]>
  getLikedArtists(limit?: number): Promise<MusicArtist[]>

  // --- Playback ---
  getStreamUrl(track: MusicTrack): Promise<string>
  getPlaybackInfo(track: MusicTrack): Promise<TrackPlaybackInfo>
  getTranscodePlaybackInfo?(
    track: MusicTrack,
    bitrate?: number,
    codec?: string
  ): Promise<TrackPlaybackInfo>
  rate(itemId: string, rating: number | null): Promise<void>
  markPlayed(trackId: string): Promise<void>
  reportProgress(
    trackId: string,
    positionMs: number,
    state: string,
    duration: number
  ): Promise<void>

  // --- Optional (capability-gated) ---
  getStreamLevels?(streamId: number, subSample?: number): Promise<LevelData[]>
  getTrackLevels?(track: MusicTrack): Promise<LevelData[]>
  getLyrics?(trackId: string): Promise<LyricLineData[]>
  getTags?(tagType: string): Promise<{ tag: string; count: number | null }[]>
  getItemsByTag?(
    tagType: string,
    tagName: string,
    type?: string,
    limit?: number,
    offset?: number
  ): Promise<PagedResult<MusicItem>>
  getMixTracks?(mixKey: string): Promise<MusicTrack[]>
  getMixTracksPage?(mixKey: string, offset: number, limit: number): Promise<PagedResult<MusicTrack>>
  getSectionStations?(): Promise<MusicHub[]>
  getArtistStations?(artistId: string): Promise<MusicPlaylist[]>

  // --- Plex-specific optional methods (sonic/radio/queue) ---
  createRadioQueue?(
    seedId: string,
    seedType: string,
    degreesOfSeparation?: number
  ): Promise<{ queueId: number; tracks: MusicTrack[] }>
  createSmartShuffleQueue?(
    seedId: string,
    seedType: string,
    djMode?: string,
    degreesOfSeparation?: number
  ): Promise<{ queueId: number; tracks: MusicTrack[] }>
  createPlayQueue?(
    uri: string,
    shuffle?: boolean,
    repeat?: number
  ): Promise<{ queueId: number; tracks: MusicTrack[] }>
  computeSonicPath?(
    startId: string,
    endId: string,
    count?: number
  ): Promise<MusicTrack[]>
  getSonicallySimilar?(
    itemId: string,
    limit?: number,
    maxDistance?: number
  ): Promise<MusicArtist[]>
  getArtistSonicallySimilar?(
    artistId: string,
    limit?: number,
    maxDistance?: number
  ): Promise<MusicArtist[]>
  getArtistPopularTracksInSection?(
    artistId: string,
    limit?: number
  ): Promise<MusicTrack[]>
  getArtistAlbumsInSection?(
    artistId: string,
    formatFilter?: string
  ): Promise<MusicAlbum[]>

  // --- Full-library sync (capability-gated) ---
  getAllArtists?(
    offset?: number,
    limit?: number
  ): Promise<PagedResult<MusicArtist>>
  getAllAlbums?(
    offset?: number,
    limit?: number
  ): Promise<PagedResult<MusicAlbum>>
  getAllTracks?(
    offset?: number,
    limit?: number
  ): Promise<PagedResult<MusicTrack>>

  // --- URI builders (needed by stores for queue creation) ---
  buildItemUri?(itemKey: string): string
  buildDirectoryUri?(itemKey: string): string
  buildPlaylistUri?(playlistKey: string): string
  buildRadioUri?(stationKey: string): string
  buildTagFilterUri?(tagType: string, tagValue: string): string

  // --- Now Playing / OS integration ---
  updateNowPlaying?(
    title: string,
    artist: string,
    album: string,
    thumbPath: string | null,
    durationMs: number
  ): Promise<void>
  setNowPlayingState?(
    state: "playing" | "paused" | "stopped",
    positionMs?: number
  ): Promise<void>

  // --- Track lifecycle hooks (scrobbling, external integrations) ---
  onTrackStart?(track: MusicTrack, isCurrent?: () => boolean): void
}
