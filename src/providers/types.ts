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

export interface ProviderCapabilities {
  search: boolean
  playlists: boolean
  playlistEdit: boolean
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
  id: string           // "plex" | "genius-{songId}"
  label: string        // "Plex" | song title from Genius
  lines: LyricLineData[]
  isSynced: boolean    // true=timed (Plex), false=plain (Genius)
}

export interface MusicProvider {
  /** Runtime identity changes when this provider revokes or replaces its connection. */
  readonly playbackSession?: unknown
  readonly name: string
  readonly capabilities: ProviderCapabilities
  /** Opaque account/server/library digest. Null disables persistent provider caches. */
  readonly cacheScope?: string | null

  // --- Connection ---
  connect(config: Record<string, unknown>): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean

  // --- Browse ---
  search(query: string, type?: "track" | "album" | "artist"): Promise<MusicItem[]>
  getRecentlyAdded(type?: string, limit?: number): Promise<MusicItem[]>
  getHubs(): Promise<MusicHub[]>

  // --- Library ---
  getTrack(id: string): Promise<MusicTrack>
  getAlbum(id: string): Promise<MusicAlbum>
  getArtist(id: string): Promise<MusicArtist>
  getAlbumTracks(albumId: string): Promise<MusicTrack[]>
  getArtistAlbums(artistId: string, formatFilter?: string): Promise<MusicAlbum[]>
  getArtistPopularTracks(artistId: string, limit?: number): Promise<MusicTrack[]>
  getArtistSimilar(artistId: string): Promise<MusicArtist[]>
  getRelatedHubs(itemId: string): Promise<MusicHub[]>

  // --- Playlists ---
  getPlaylists(): Promise<MusicPlaylist[]>
  getPlaylistItems(playlistId: string, offset?: number, limit?: number): Promise<PagedResult<MusicTrack>>
  createPlaylist(title: string, itemIds: string[]): Promise<MusicPlaylist>
  addToPlaylist(playlistId: string, itemIds: string[]): Promise<void>
  removeFromPlaylist(playlistId: string, playlistItemIds: string[]): Promise<void>
  deletePlaylist(playlistId: string): Promise<void>
  editPlaylist(playlistId: string, title?: string, summary?: string): Promise<void>
  movePlaylistItem(playlistId: string, itemId: string, afterItemId: string): Promise<void>

  // --- Liked ---
  getLikedTracks(limit?: number): Promise<MusicTrack[]>
  getLikedAlbums(limit?: number): Promise<MusicAlbum[]>
  getLikedArtists(limit?: number): Promise<MusicArtist[]>

  // --- Playback ---
  getStreamUrl(track: MusicTrack): Promise<string>
  getPlaybackInfo(track: MusicTrack): Promise<TrackPlaybackInfo>
  getTranscodePlaybackInfo?(track: MusicTrack, bitrate?: number, codec?: string): Promise<TrackPlaybackInfo>
  rate(itemId: string, rating: number | null): Promise<void>
  markPlayed(trackId: string): Promise<void>
  reportProgress(trackId: string, positionMs: number, state: string, duration: number): Promise<void>

  // --- Optional (capability-gated) ---
  getStreamLevels?(streamId: number, subSample?: number): Promise<LevelData[]>
  getLyrics?(trackId: string): Promise<LyricLineData[]>
  getTags?(tagType: string): Promise<{ tag: string; count: number | null }[]>
  getItemsByTag?(tagType: string, tagName: string, type?: string, limit?: number, offset?: number): Promise<PagedResult<MusicItem>>
  getMixTracks?(mixKey: string): Promise<MusicTrack[]>
  getSectionStations?(): Promise<MusicHub[]>
  getArtistStations?(artistId: string): Promise<MusicPlaylist[]>

  // --- Plex-specific optional methods (sonic/radio/queue) ---
  createRadioQueue?(seedId: string, seedType: string, degreesOfSeparation?: number): Promise<{ queueId: number; tracks: MusicTrack[] }>
  createSmartShuffleQueue?(seedId: string, seedType: string, djMode?: string, degreesOfSeparation?: number): Promise<{ queueId: number; tracks: MusicTrack[] }>
  createPlayQueue?(uri: string, shuffle?: boolean, repeat?: number): Promise<{ queueId: number; tracks: MusicTrack[] }>
  computeSonicPath?(startId: string, endId: string, count?: number): Promise<MusicTrack[]>
  getSonicallySimilar?(itemId: string, limit?: number, maxDistance?: number): Promise<MusicArtist[]>
  getArtistSonicallySimilar?(artistId: string, limit?: number, maxDistance?: number): Promise<MusicArtist[]>
  getArtistPopularTracksInSection?(artistId: string, limit?: number): Promise<MusicTrack[]>
  getArtistAlbumsInSection?(artistId: string, formatFilter?: string): Promise<MusicAlbum[]>

  // --- Full-library sync (capability-gated) ---
  getAllArtists?(offset?: number, limit?: number): Promise<PagedResult<MusicArtist>>
  getAllAlbums?(offset?: number, limit?: number): Promise<PagedResult<MusicAlbum>>
  getAllTracks?(offset?: number, limit?: number): Promise<PagedResult<MusicTrack>>

  // --- URI builders (needed by stores for queue creation) ---
  buildItemUri?(itemKey: string): string
  buildDirectoryUri?(itemKey: string): string
  buildPlaylistUri?(playlistKey: string): string
  buildRadioUri?(stationKey: string): string
  buildTagFilterUri?(tagType: string, tagValue: string): string

  // --- Now Playing / OS integration ---
  updateNowPlaying?(title: string, artist: string, album: string, thumbPath: string | null, durationMs: number): Promise<void>
  setNowPlayingState?(state: "playing" | "paused" | "stopped", positionMs?: number): Promise<void>

  // --- Track lifecycle hooks (scrobbling, external integrations) ---
  onTrackStart?(track: MusicTrack, isCurrent?: () => boolean): void
  onTrackEnd?(track: MusicTrack, startedAtUnix: number, listenedMs: number): void
}
