/** Plex library RPCs retain their originating native connection and library. */
import { invoke as nativeInvoke } from "@tauri-apps/api/core"
import type {
  Album,
  Artist,
  Hub,
  IdentityResponse,
  Level,
  LibrarySection,
  LibraryTag,
  LyricLine,
  PagedMediaItems,
  PlayQueue,
  Playlist,
  PlexMedia,
  ServerInfo,
  Track,
} from "./types"

export interface PlexRequestContext {
  connectionRevision: number
  cacheScope: string
}
export type PlexTransport = <T>(
  command: string,
  args?: Record<string, unknown>
) => Promise<T>

export function createPlexApi(
  context: PlexRequestContext,
  transport: PlexTransport = nativeInvoke,
  ownsRequest: () => boolean = () => true
) {
  if (
    !Number.isSafeInteger(context.connectionRevision) ||
    context.connectionRevision < 0 ||
    !/^plex-[a-f0-9]{64}$/.test(context.cacheScope)
  ) {
    throw new Error("Invalid Plex connection context")
  }
  // Copy ownership: mutating the caller's context cannot retarget this API.
  const requestContext = Object.freeze({
    connectionRevision: context.connectionRevision,
    cacheScope: context.cacheScope,
  })
  const check = () => {
    if (!ownsRequest()) throw new Error("Plex connection was superseded")
  }
  async function invoke<T>(
    command: string,
    args: Record<string, unknown> = {}
  ): Promise<T> {
    check()
    const result = await transport<T>(command, {
      ...args,
      context: requestContext,
    })
    check()
    return result
  }

  // ---------------------------------------------------------------------------
  // Library
  // ---------------------------------------------------------------------------

  /** Get all library sections on the server. */
  function getLibrarySections(): Promise<LibrarySection[]> {
    return invoke("get_library_sections")
  }

  /**
   * Search a library section.
   * @param libtype Optional filter: "artist" | "album" | "track"
   */
  function searchLibrary(
    sectionId: number,
    query: string,
    libtype?: string
  ): Promise<PlexMedia[]> {
    return invoke("search_library", {
      sectionId,
      query,
      libtype: libtype ?? null,
    })
  }

  /** Get recently added items in a section. */
  function getRecentlyAdded(
    sectionId: number,
    libtype?: string,
    limit?: number
  ): Promise<PlexMedia[]> {
    return invoke("get_recently_added", {
      sectionId,
      libtype: libtype ?? null,
      limit: limit ?? null,
    })
  }

  /** Get discovery hubs (home screen cards) for a section. */
  function getHubs(sectionId: number): Promise<Hub[]> {
    return invoke("get_hubs", { sectionId })
  }

  /** Get "on deck" / continue listening items for a section. */
  function getOnDeck(sectionId: number): Promise<PlexMedia[]> {
    return invoke("get_on_deck", { sectionId })
  }

  /**
   * Get tags (genres, moods, styles) for a library section.
   * @param tagType "genre" | "mood" | "style"
   */
  function getSectionTags(
    sectionId: number,
    tagType: string
  ): Promise<LibraryTag[]> {
    return invoke("get_section_tags", { sectionId, tagType })
  }

  /** Get albums (or artists/tracks) filtered by a tag (genre/mood/style). libtype: "8"=artist, "9"=album, "10"=track. */
  function getItemsByTag(
    sectionId: number,
    tagType: "genre" | "mood" | "style",
    tagName: string,
    libtype?: string,
    limit = 100,
    offset = 0
  ): Promise<PagedMediaItems> {
    return invoke("get_items_by_tag", {
      sectionId,
      tagType,
      tagName,
      libtype,
      limit,
      offset,
    })
  }

  // ---------------------------------------------------------------------------
  // Metadata fetch
  // ---------------------------------------------------------------------------

  /** Get a specific track by its rating key. */
  function getTrack(ratingKey: number): Promise<Track> {
    return invoke("get_track", { ratingKey })
  }

  /** Get an artist by rating key. */
  function getArtist(ratingKey: number): Promise<Artist> {
    return invoke("get_artist", { ratingKey })
  }

  /** Get an album by rating key. */
  function getAlbum(ratingKey: number): Promise<Album> {
    return invoke("get_album", { ratingKey })
  }

  /**
   * Get albums by an artist.
   * @param formatFilter Optional Plex `album.format` filter:
   *   - `undefined` / `null` → all albums
   *   - `"Single"` → only singles
   *   - `"!Single"` → full albums and EPs (excludes singles)
   */
  function getArtistAlbums(
    ratingKey: number,
    formatFilter?: string
  ): Promise<Album[]> {
    return invoke("get_artist_albums", {
      ratingKey,
      formatFilter: formatFilter ?? null,
    })
  }

  /** Get all tracks in an album. */
  function getAlbumTracks(ratingKey: number): Promise<Track[]> {
    return invoke("get_album_tracks", { ratingKey })
  }

  /** Get popular tracks for an artist (PlexAmp-style top tracks). */
  function getArtistPopularTracks(
    ratingKey: number,
    limit?: number
  ): Promise<Track[]> {
    return invoke("get_artist_popular_tracks", {
      ratingKey,
      limit: limit ?? null,
    })
  }

  /** Get popular tracks for an artist using the /popularLeaves endpoint. */
  function getArtistPopularLeaves(
    ratingKey: number,
    limit?: number
  ): Promise<Track[]> {
    return invoke("get_artist_popular_leaves", {
      ratingKey,
      limit: limit ?? null,
    })
  }

  /** Get metadata-based similar artists (from AllMusic/MusicBrainz). */
  function getArtistSimilar(ratingKey: number): Promise<Artist[]> {
    return invoke("get_artist_similar", { ratingKey })
  }

  /** Get sonically similar artists using the /nearest endpoint. */
  function getArtistSonicallySimilar(
    ratingKey: number,
    limit?: number,
    maxDistance?: number
  ): Promise<Artist[]> {
    return invoke("get_artist_sonically_similar", {
      ratingKey,
      limit: limit ?? null,
      maxDistance: maxDistance ?? null,
    })
  }

  /** Get albums for an artist using the section-specific endpoint (better deduplication). */
  function getArtistAlbumsInSection(
    sectionId: number,
    ratingKey: number,
    format?: string
  ): Promise<Album[]> {
    return invoke("get_artist_albums_in_section", {
      sectionId,
      ratingKey,
      format: format ?? null,
    })
  }

  /** Get popular tracks for an artist using the section-specific endpoint (server-side dedup via group=title). */
  function getArtistPopularTracksInSection(
    sectionId: number,
    ratingKey: number,
    limit?: number
  ): Promise<Track[]> {
    return invoke("get_artist_popular_tracks_in_section", {
      sectionId,
      ratingKey,
      limit: limit ?? null,
    })
  }

  /** Get hubs related to a specific item (e.g., sonically similar artists). */
  function getRelatedHubs(ratingKey: number, limit?: number): Promise<Hub[]> {
    return invoke("get_related_hubs", { ratingKey, limit: limit ?? null })
  }

  // ---------------------------------------------------------------------------
  // Playlists
  // ---------------------------------------------------------------------------

  /** List all playlists in a library section. */
  function getPlaylists(sectionId: number): Promise<Playlist[]> {
    return invoke("get_playlists", { sectionId })
  }

  /** Get tracks that the user has rated (liked), sorted by most recently rated. */
  function getLikedTracks(sectionId: number, limit?: number): Promise<Track[]> {
    return invoke("get_liked_tracks", { sectionId, limit: limit ?? null })
  }

  /** Get artists that the user has rated (liked), sorted by most recently rated. */
  function getLikedArtists(
    sectionId: number,
    limit?: number
  ): Promise<Artist[]> {
    return invoke("get_liked_artists", { sectionId, limit: limit ?? null })
  }

  /** Get albums that the user has rated (liked), sorted by most recently rated. */
  function getLikedAlbums(sectionId: number, limit?: number): Promise<Album[]> {
    return invoke("get_liked_albums", { sectionId, limit: limit ?? null })
  }

  /**
   * Fetch the track list for a "Mix for You" hub item.
   * Pass the raw `key` field from the hub mix item — the backend appends
   * `&type=10` automatically when it's missing.
   */
  function getMixTracks(key: string): Promise<Track[]> {
    return invoke("get_mix_tracks", { key })
  }

  /** Get tracks inside a playlist, with optional pagination. */
  function getPlaylistItems(
    playlistId: number,
    limit?: number,
    offset?: number
  ): Promise<Track[]> {
    return invoke("get_playlist_items", {
      playlistId,
      limit: limit ?? null,
      offset: offset ?? null,
    })
  }

  /** Fetch a playlist page while retaining Plex's totalSize. */
  function getPlaylistItemsPage(
    playlistId: number,
    limit?: number,
    offset?: number
  ): Promise<{ items: Track[]; total: number }> {
    return invoke("get_playlist_items_page", {
      playlistId,
      limit: limit ?? null,
      offset: offset ?? null,
    })
  }

  /** Create a new playlist from a list of track rating keys. */
  function createPlaylist(
    title: string,
    sectionId: number,
    itemIds: number[]
  ): Promise<Playlist> {
    return invoke("create_playlist", { title, sectionId, itemIds })
  }

  /** Add items to an existing playlist by rating key. */
  function addItemsToPlaylist(
    playlistId: number,
    itemIds: number[]
  ): Promise<void> {
    return invoke("add_items_to_playlist", { playlistId, itemIds })
  }

  /** Remove items from a playlist by their playlist-specific item IDs. */
  function removeItemsFromPlaylist(
    playlistId: number,
    playlistItemIds: number[]
  ): Promise<void> {
    return invoke("remove_items_from_playlist", { playlistId, playlistItemIds })
  }

  /** Move an item within a playlist (reorder). Use afterItemId=0 to move to top. */
  function movePlaylistItem(
    playlistId: number,
    itemId: number,
    afterItemId: number
  ): Promise<void> {
    return invoke("move_playlist_item", { playlistId, itemId, afterItemId })
  }

  /** Delete a playlist by its rating key. */
  function deletePlaylist(playlistId: number): Promise<void> {
    return invoke("delete_playlist", { playlistId })
  }

  /** Edit playlist metadata (title and/or summary). */
  function editPlaylist(
    playlistId: number,
    title?: string,
    summary?: string
  ): Promise<void> {
    return invoke("edit_playlist", {
      playlistId,
      title: title ?? null,
      summary: summary ?? null,
    })
  }

  // ---------------------------------------------------------------------------
  // Play queue
  // ---------------------------------------------------------------------------

  /**
   * Create a server-side play queue.
   *
   * Build the URI with the `buildItemUri` / `buildDirectoryUri` helpers, or
   * pass a raw path like `/library/metadata/{ratingKey}`.
   *
   * @param repeat 0 = off, 1 = repeat-one, 2 = repeat-all
   */
  function createPlayQueue(
    uri: string,
    shuffle: boolean,
    repeat: number
  ): Promise<PlayQueue> {
    return invoke("create_play_queue", { uri, shuffle, repeat })
  }

  /** Fetch an existing play queue by ID. */
  function getPlayQueue(queueId: number): Promise<PlayQueue> {
    return invoke("get_play_queue", { queueId })
  }

  /**
   * Add items to an existing play queue.
   * @param next If true, insert after current item; if false, append to end.
   */
  function addToPlayQueue(
    queueId: number,
    uri: string,
    next: boolean
  ): Promise<PlayQueue> {
    return invoke("add_to_play_queue", { queueId, uri, next })
  }

  /**
   * Create a radio play queue seeded from any Plex item.
   *
   * Uses PlexAmp's `plex://radio` URI scheme — the Plex server generates a
   * continuously-refreshing, sonically-curated stream of recommendations.
   *
   * @param ratingKey  Seed item (track, album, or artist rating key)
   * @param degreesOfSeparation  Diversity: -1 = unlimited, 0 = closest only, 3+ = adventurous
   * @param includeExternal  Include tracks from external/cloud sources
   * @param shuffle  Shuffle the initial queue
   */
  function createRadioQueue(
    ratingKey: number,
    itemType: string,
    degreesOfSeparation?: number,
    includeExternal?: boolean,
    shuffle?: boolean
  ): Promise<PlayQueue> {
    return invoke("create_radio_queue", {
      ratingKey,
      itemType,
      degreesOfSeparation: degreesOfSeparation ?? null,
      includeExternal: includeExternal ?? false,
      shuffle: shuffle ?? false,
    })
  }

  /**
   * Create a Guest DJ (smart-shuffle) play queue.
   *
   * Like `createRadioQueue` but uses Plex's AI-curated `smartShuffle` mode and
   * the "Guest DJ" persona header for richer contextual recommendations.
   *
   * @param ratingKey  Seed item rating key
   * @param degreesOfSeparation  Diversity: -1 = unlimited
   * @param includeExternal  Include external sources
   */
  function createSmartShuffleQueue(
    ratingKey: number,
    itemType: string,
    djMode?: string,
    degreesOfSeparation?: number,
    includeExternal?: boolean
  ): Promise<PlayQueue> {
    return invoke("create_smart_shuffle_queue", {
      ratingKey,
      itemType,
      djMode: djMode ?? null,
      degreesOfSeparation: degreesOfSeparation ?? null,
      includeExternal: includeExternal ?? false,
    })
  }

  // ---------------------------------------------------------------------------
  // Playback tracking
  // ---------------------------------------------------------------------------

  /** Mark an item as played (scrobble). */
  function markPlayed(ratingKey: number): Promise<void> {
    return invoke("mark_played", { ratingKey })
  }

  /** Mark an item as unplayed. */
  function markUnplayed(ratingKey: number): Promise<void> {
    return invoke("mark_unplayed", { ratingKey })
  }

  /**
   * Report playback progress to the server.
   * Call every ~10 seconds during playback.
   */
  function reportTimeline(
    ratingKey: number,
    stateStr: "playing" | "paused" | "buffering" | "stopped",
    timeMs: number,
    durationMs: number
  ): Promise<void> {
    return invoke("report_timeline", {
      ratingKey,
      stateStr,
      timeMs,
      durationMs,
    })
  }

  // ---------------------------------------------------------------------------
  // Ratings (Phase 3)
  // ---------------------------------------------------------------------------

  /**
   * Rate a library item.
   *
   * `rating` is on a 0–10 scale (Plex half-star: 2 = 1★, 10 = 5★).
   * Pass `null` to clear an existing rating.
   */
  function rateItem(ratingKey: number, rating: number | null): Promise<void> {
    return invoke("rate_item", { ratingKey, rating })
  }

  // ---------------------------------------------------------------------------
  // Sonic / PlexAmp features (Phase 2)
  // ---------------------------------------------------------------------------

  /** Get tracks sonically similar to a given track. */
  function getSonicallySimilar(
    ratingKey: number,
    limit?: number,
    maxDistance?: number
  ): Promise<Track[]> {
    return invoke("get_sonically_similar", {
      ratingKey,
      limit: limit ?? null,
      maxDistance: maxDistance ?? null,
    })
  }

  /** Get a track radio (mix) seeded from a track. */
  function getTrackRadio(
    sectionId: number,
    ratingKey: number,
    limit?: number
  ): Promise<Track[]> {
    return invoke("get_track_radio", {
      sectionId,
      ratingKey,
      limit: limit ?? null,
    })
  }

  /**
   * Get radio stations seeded from an artist.
   * Returns playlists with `radio: true`.
   */
  function getArtistStations(ratingKey: number): Promise<Playlist[]> {
    return invoke("get_artist_stations", { ratingKey })
  }

  /**
   * Get all music stations available in a library section.
   *
   * Returns discovery hubs; filter by `hub.hub_identifier` containing
   * `"station"` to extract the station playlists from `hub.metadata`.
   */
  function getSectionStations(sectionId: number): Promise<Hub[]> {
    return invoke("get_section_stations", { sectionId })
  }

  /**
   * Compute a sonic path between two tracks.
   *
   * Returns intermediate tracks that bridge the sonic gap between `fromId`
   * and `toId` — the PlexAmp "Sonic Adventure" via `computePath`.
   */
  function computeSonicPath(
    sectionId: number,
    fromId: number,
    toId: number
  ): Promise<Track[]> {
    return invoke("compute_sonic_path", { sectionId, fromId, toId })
  }

  /**
   * Get loudness/peak level data for a media stream.
   *
   * Use for waveform visualisation. `streamId` is the selected audio Stream ID.
   * `subSample` controls resolution (128 = PlexAmp default).
   */
  function getStreamLevels(
    streamId: number,
    subSample?: number
  ): Promise<Level[]> {
    return invoke("get_stream_levels", {
      streamId,
      subSample: subSample ?? null,
    })
  }

  // ---------------------------------------------------------------------------
  // Streaming URLs (Phase 4)
  // ---------------------------------------------------------------------------

  /**
   * Build a direct-play stream URL for a media part.
   *
   * Pass the selected media part key as `partKey`.
   * Returns a URL you can set as the `src` of an `<audio>` element.
   */
  function getStreamUrl(partKey: string): Promise<string> {
    return invoke("get_stream_url", { partKey })
  }

  /**
   * Build an artwork/thumbnail URL.
   *
   * Pass `track.thumb`, `album.thumb`, `artist.thumb`, etc. as `thumbPath`.
   */
  function getThumbUrl(thumbPath: string): Promise<string> {
    return invoke("get_thumb_url", { thumbPath })
  }

  /**
   * Build an audio transcode URL.
   *
   * Use when the client cannot play the native format.
   * @param bitrate Max bitrate in kbps (e.g. 320)
   * @param codec Target codec: "mp3" | "aac" | "opus"
   */
  function getAudioTranscodeUrl(
    partKey: string,
    bitrate?: number,
    codec?: string
  ): Promise<string> {
    return invoke("get_audio_transcode_url", {
      partKey,
      bitrate: bitrate ?? null,
      codec: codec ?? null,
    })
  }

  // ---------------------------------------------------------------------------
  // Server info (Phase 5)
  // ---------------------------------------------------------------------------

  /** Get the server's identity (machine ID, version, claimed status). */
  function getIdentity(): Promise<IdentityResponse> {
    return invoke("get_identity")
  }

  /** Get full server capabilities and metadata. */
  function getServerInfo(): Promise<ServerInfo> {
    return invoke("get_server_info")
  }

  /** Fetch parsed lyrics for a track. Returns [] if the track has no lyrics. */
  function getLyrics(ratingKey: number): Promise<LyricLine[]> {
    return invoke("get_lyrics", { ratingKey })
  }

  // ---------------------------------------------------------------------------
  // Now Playing / system media controls
  // ---------------------------------------------------------------------------

  /**
   * Push track metadata to the OS Now Playing system.
   *
   * - macOS: Control Centre, lock screen, AirPlay targets
   * - Windows: SMTC lock screen / taskbar
   * - Linux: MPRIS2 panel
   *
   * `thumbPath` is a Plex path like `/library/metadata/123/thumb`; Rust builds
   * the authenticated URL so the token never appears in frontend logs.
   */
  function updateNowPlaying(
    title: string,
    artist: string,
    album: string,
    thumbPath: string | null,
    durationMs: number
  ): Promise<void> {
    return invoke("update_now_playing", {
      title,
      artist,
      album,
      thumbPath,
      durationMs,
    })
  }

  /**
   * Update the playback state in the OS media controls.
   * `playbackState` must be `"playing"`, `"paused"`, or `"stopped"`.
   */
  function setNowPlayingState(
    playbackState: "playing" | "paused" | "stopped",
    positionMs?: number
  ): Promise<void> {
    return invoke("set_now_playing_state", { playbackState, positionMs })
  }

  return {
    context: requestContext,
    getLibrarySections,
    searchLibrary,
    getRecentlyAdded,
    getHubs,
    getOnDeck,
    getSectionTags,
    getItemsByTag,
    getTrack,
    getArtist,
    getAlbum,
    getArtistAlbums,
    getAlbumTracks,
    getArtistPopularTracks,
    getArtistPopularLeaves,
    getArtistSimilar,
    getArtistSonicallySimilar,
    getArtistAlbumsInSection,
    getArtistPopularTracksInSection,
    getRelatedHubs,
    getPlaylists,
    getLikedTracks,
    getLikedArtists,
    getLikedAlbums,
    getMixTracks,
    getPlaylistItems,
    getPlaylistItemsPage,
    createPlaylist,
    addItemsToPlaylist,
    removeItemsFromPlaylist,
    movePlaylistItem,
    deletePlaylist,
    editPlaylist,
    createPlayQueue,
    getPlayQueue,
    addToPlayQueue,
    createRadioQueue,
    createSmartShuffleQueue,
    markPlayed,
    markUnplayed,
    reportTimeline,
    rateItem,
    getSonicallySimilar,
    getTrackRadio,
    getArtistStations,
    getSectionStations,
    computeSonicPath,
    getStreamLevels,
    getStreamUrl,
    getThumbUrl,
    getAudioTranscodeUrl,
    getIdentity,
    getServerInfo,
    getLyrics,
    updateNowPlaying,
    setNowPlayingState,
  }
}
export type PlexApi = ReturnType<typeof createPlexApi>
