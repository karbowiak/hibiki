import type {
  LibraryMetadataPatch,
  LibraryMetadataExpected,
  LibraryArtworkInventory,
  PlaylistOccurrenceState,
  PlaylistOccurrenceMutation,
} from "../../providers/types"
/**
 * PlexProvider — wraps scoped native Plex calls behind the MusicProvider interface.
 *
 * Holds sectionId, sectionUuid, baseUrl, and token internally.
 * Mappers convert Plex types to generic types, resolving image URLs during conversion.
 */

import { providerCacheScope } from "../../lib/providerCacheScope"
import type {
  MusicProvider,
  ProviderCapabilities,
  LevelData,
  LyricLineData,
  TrackPlaybackInfo,
} from "../../providers/types"
import type {
  MusicTrack,
  MusicAlbum,
  MusicArtist,
  MusicPlaylist,
  MusicItem,
  MusicHub,
  PagedResult,
} from "../../types/music"
import type { Track, LibrarySection } from "./types"
import { createPlexApi, type PlexApi, type PlexTransport } from "./scopedApi"
import {
  plexTrackToMusicTrack,
  plexAlbumToMusicAlbum,
  plexArtistToMusicArtist,
  plexPlaylistToMusicPlaylist,
  plexMediaToMusicItem,
  plexHubToMusicHub,
  type ImgResolver,
} from "./mappers"

import * as plex from "./api"
import { lastfmUpdateNowPlaying } from "../../metadata/lastfm/api"
import {
  listenbrainzSubmitNowPlaying,
  type ListenBrainzMbids,
} from "../../metadata/listenbrainz/api"
import { useMbidStore } from "../../metadata/musicbrainz/mbidStore"
import { buildPlexImageUrl } from "./imageUrl"
import { pickBestMediaIndex } from "../../lib/dedup"
import { localAudioTrack } from "../../offline/audio"
import { createFavoritesNative } from "../../favorites/native"
import { projectOfflineAvailability } from "../../offline/catalogue"

export class PlexProvider implements MusicProvider {
  private nowPlayingGeneration = 0
  constructor(private transport?: PlexTransport) {}
  readonly name = "Plex"
  readonly capabilities: ProviderCapabilities = {
    search: true,
    playlists: true,
    playlistEdit: true,
    metadataEdit: true,
    ratings: true,
    radio: true,
    sonicSimilarity: true,
    djModes: true,
    playQueues: true,
    lyrics: true,
    streamLevels: true,
    hubs: true,
    stations: true,
    tags: true,
    scrobble: true,
    mixTracks: true,
    browseArtists: true,
    browseAlbums: true,
    browseTracks: true,
    syncArtists: true,
    syncAlbums: true,
    syncTracks: true,
  }

  private _cacheScope: string | null = null
  get cacheScope() {
    return this._cacheScope
  }

  private _connected = false
  private _connectionGeneration = 0
  private _api: PlexApi | null = null
  private get api(): PlexApi {
    if (!this._connected || !this._api)
      throw new Error("Plex provider is disconnected")
    return this._api
  }
  private _baseUrl = ""
  private _token = ""
  private _sectionId: number | null = null
  private _sectionUuid: string | null = null
  private _machineIdentifier = ""

  get playbackSession(): unknown {
    return this._api
  }
  get favorites() {
    const api = this._api,
      section = this._sectionId
    if (!api || !this._connected || !section) return undefined
    return createFavoritesNative(
      api.context,
      section,
      this.transport,
      () => this._api === api && this._connected,
      async (rows) => {
        const tracks = rows.map((row) => plexTrackToMusicTrack(row, this.img))
        return (await projectOfflineAvailability(
          api.context,
          tracks
        )) as MusicTrack[]
      }
    )
  }
  get sectionId(): number | null {
    return this._sectionId
  }
  get sectionUuid(): string | null {
    return this._sectionUuid
  }
  get baseUrl(): string {
    return this._baseUrl
  }
  get token(): string {
    return this._token
  }
  get machineIdentifier(): string {
    return this._machineIdentifier
  }

  /** Image resolver bound to current connection credentials. */
  private img: ImgResolver = () => ""

  private rebuildImg() {
    const base = this._baseUrl
    const token = this._token
    const scope = this._cacheScope
    this.img = (path, entityType, entityId, name, artist) =>
      buildPlexImageUrl(
        base,
        token,
        entityType,
        entityId,
        path,
        name,
        artist,
        scope
      ) ?? ""
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  async connect(config: Record<string, unknown>): Promise<void> {
    const generation = ++this._connectionGeneration
    this._connected = false
    this._api = null
    const baseUrl = config.baseUrl as string
    const token = config.token as string
    const sectionId = config.sectionId as number
    const sectionUuid = (config.sectionUuid as string) ?? null
    const scope =
      typeof config.cacheScope === "string" &&
      /^plex-[a-f0-9]{64}$/.test(config.cacheScope)
        ? config.cacheScope
        : await providerCacheScope(
            "plex",
            (config.machineIdentifier as string) ?? "",
            token,
            sectionUuid || String(sectionId),
            baseUrl
          )
    if (generation !== this._connectionGeneration)
      throw new Error("Plex connection was superseded")
    this._api = createPlexApi(
      {
        connectionRevision: config.connectionRevision as number,
        cacheScope: scope,
      },
      this.transport,
      () => this._connected && generation === this._connectionGeneration
    )

    this._baseUrl = baseUrl
    this._token = token
    this._sectionId = sectionId
    this._sectionUuid = sectionUuid
    this._machineIdentifier = (config.machineIdentifier as string) ?? ""
    this._cacheScope = scope
    this.rebuildImg()
    this._connected = true
  }

  async disconnect(): Promise<void> {
    ++this._connectionGeneration
    this._connected = false
    this._api = null
    this._cacheScope = null
    this._sectionId = null
    this._sectionUuid = null
    this._baseUrl = ""
    this._token = ""
    this._machineIdentifier = ""
    this.rebuildImg()
  }

  isConnected(): boolean {
    return this._connected
  }

  async getLocalAudio(offset = 0, limit = 100, cached = false) {
    const api = this.api,
      base = this._baseUrl,
      scope = this._cacheScope!
    const page = await api.localAudio(offset, limit, cached)
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        track: item.track ? localAudioTrack(item.track, base, scope) : null,
      })),
    }
  }
  downloadTracks(ids: string[]) {
    return this.api.downloadTracks(
      ids.map((id) => {
        if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
          throw new Error("Invalid Plex track")
        return Number(id)
      })
    )
  }
  removeDownload(id: string) {
    return this.api.removeDownload(Number(id))
  }
  resumeDownloads() {
    return this.api.resumeDownloads()
  }

  getLibrarySections(): Promise<LibrarySection[]> {
    return this.api.getLibrarySections()
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private requireSection(): number {
    if (this._sectionId === null)
      throw new Error("PlexProvider: no music section selected")
    return this._sectionId
  }

  private mapTrack = (t: Track): MusicTrack =>
    plexTrackToMusicTrack(t, this.img)
  private mapTracks = (ts: Track[]): MusicTrack[] => ts.map(this.mapTrack)

  // ---------------------------------------------------------------------------
  // Browse
  // ---------------------------------------------------------------------------

  async search(
    query: string,
    type?: "track" | "album" | "artist"
  ): Promise<MusicItem[]> {
    const sid = this.requireSection()
    const libtype =
      type === "track"
        ? "10"
        : type === "album"
          ? "9"
          : type === "artist"
            ? "8"
            : undefined
    const results = await this.api.searchLibrary(sid, query, libtype)
    return results
      .map((m) => plexMediaToMusicItem(m, this.img))
      .filter((x): x is MusicItem => x !== null)
  }

  async findPlaylistCandidates(
    source: import("../../providers/types").PlaylistRecordingTrack & {
      recordingMbid?: string | null
    }
  ) {
    const result = await this.api.findPlaylistCandidates(
      this.requireSection(),
      source
    )
    return { ...result, tracks: this.mapTracks(result.tracks) }
  }

  async getRecentlyAdded(type?: string, limit?: number): Promise<MusicItem[]> {
    const sid = this.requireSection()
    const items = await this.api.getRecentlyAdded(sid, type, limit)
    return items
      .map((m) => plexMediaToMusicItem(m, this.img))
      .filter((x): x is MusicItem => x !== null)
  }

  async getHubs(): Promise<MusicHub[]> {
    const sid = this.requireSection()
    const hubs = await this.api.getHubs(sid)
    return hubs.map((h) => plexHubToMusicHub(h, this.img))
  }

  async getDiscoveryPage(kind: "recent" | "latest" | "hub", offset: number, limit: number, hub?: MusicHub): Promise<PagedResult<MusicItem>> {
    const page = await this.api.getDiscoveryPage(this.requireSection(), kind, offset, limit, hub?.identifier, hub?.key)
    return { ...page, items: page.items.map(item => plexMediaToMusicItem(item, this.img)).filter((item): item is MusicItem => item !== null) }
  }

  async getLatestReleases(limit = 30): Promise<MusicAlbum[]> {
    const albums = await this.api.getLatestReleases(
      this.requireSection(),
      limit
    )
    return albums.map((album) => plexAlbumToMusicAlbum(album, this.img))
  }

  // ---------------------------------------------------------------------------
  // Library
  // ---------------------------------------------------------------------------

  async getTrack(id: string): Promise<MusicTrack> {
    const t = await this.api.getTrack(Number(id))
    const track = plexTrackToMusicTrack(t, this.img)
    track.mediaInfo = { ...track.mediaInfo, metadataComplete: true }
    return track
  }

  async getAlbum(id: string): Promise<MusicAlbum> {
    const a = await this.api.getAlbum(Number(id))
    return plexAlbumToMusicAlbum(a, this.img)
  }

  async getArtist(id: string): Promise<MusicArtist> {
    const a = await this.api.getArtist(Number(id))
    return plexArtistToMusicArtist(a, this.img)
  }

  async getAlbumTracks(albumId: string): Promise<MusicTrack[]> {
    const tracks = await this.api.getAlbumTracks(Number(albumId))
    return this.mapTracks(tracks)
  }

  async getArtistAlbums(
    artistId: string,
    formatFilter?: string
  ): Promise<MusicAlbum[]> {
    const albums = await this.api.getArtistAlbums(
      Number(artistId),
      formatFilter
    )
    return albums.map((a) => plexAlbumToMusicAlbum(a, this.img))
  }

  async getArtistPopularTracks(
    artistId: string,
    limit?: number
  ): Promise<MusicTrack[]> {
    const tracks = await this.api.getArtistPopularTracks(
      Number(artistId),
      limit
    )
    return this.mapTracks(tracks)
  }

  async getArtistSimilar(artistId: string): Promise<MusicArtist[]> {
    const artists = await this.api.getArtistSimilar(Number(artistId))
    return artists.map((a) => plexArtistToMusicArtist(a, this.img))
  }

  async getRelatedHubs(itemId: string): Promise<MusicHub[]> {
    const hubs = await this.api.getRelatedHubs(Number(itemId))
    return hubs.map((h) => plexHubToMusicHub(h, this.img))
  }

  // ---------------------------------------------------------------------------
  // Playlists
  // ---------------------------------------------------------------------------

  async getPlaylists(): Promise<MusicPlaylist[]> {
    const sid = this.requireSection()
    const playlists = await this.api.getPlaylists(sid)
    return playlists.map((p) => plexPlaylistToMusicPlaylist(p, this.img))
  }

  async getPlaylistItems(
    playlistId: string,
    offset?: number,
    limit?: number
  ): Promise<PagedResult<MusicTrack>> {
    const page = await this.api.getPlaylistItemsPage(
      Number(playlistId),
      limit,
      offset
    )
    return {
      items: this.mapTracks(page.items),
      total: page.total,
      ...(page.offset !== undefined ? { offset: page.offset } : {}),
    }
  }

  async createPlaylist(
    title: string,
    itemIds: string[]
  ): Promise<MusicPlaylist> {
    const sid = this.requireSection()
    const p = await this.api.createPlaylist(title, sid, itemIds.map(Number))
    return plexPlaylistToMusicPlaylist(p, this.img)
  }

  async mutatePlaylistOccurrence(
    playlistId: string,
    expected: PlaylistOccurrenceState,
    operation: PlaylistOccurrenceMutation
  ): Promise<PlaylistOccurrenceState> {
    return this.api.mutatePlaylistOccurrence(
      Number(playlistId),
      this.requireSection(),
      expected,
      operation
    )
  }

  async resolvePlaylistRecording(
    track: import("../../providers/types").PlaylistRecordingTrack
  ): Promise<import("../../providers/types").PlaylistRecordingResolution> {
    return this.api.resolvePlaylistRecording(this.requireSection(), track)
  }
  async describePlaylist(
    playlistId: string,
    expected: PlaylistOccurrenceState,
    expectedDescription: string,
    description: string
  ): Promise<string> {
    return this.api.describePlaylist(
      Number(playlistId),
      this.requireSection(),
      expected,
      expectedDescription,
      description
    )
  }
  async addToPlaylist(playlistId: string, itemIds: string[]): Promise<void> {
    await this.api.addItemsToPlaylist(Number(playlistId), itemIds.map(Number))
  }

  async removeFromPlaylist(
    playlistId: string,
    playlistItemIds: string[]
  ): Promise<void> {
    await this.api.removeItemsFromPlaylist(
      Number(playlistId),
      playlistItemIds.map(Number)
    )
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    await this.api.deletePlaylist(Number(playlistId))
  }

  async getAdvancedMetadata(
    kind: "artist" | "album",
    itemId: string
  ): Promise<import("../../lib/metadataAdvanced").AdvancedMetadata> {
    if (!/^[1-9]\d*$/.test(itemId) || !Number.isSafeInteger(Number(itemId)))
      throw Error("Invalid Plex item ID")
    return this.api.getAdvancedMetadata(
      this.requireSection(),
      Number(itemId),
      kind
    )
  }
  async editAdvancedMetadata(
    kind: "artist" | "album",
    itemId: string,
    patch: import("../../lib/metadataAdvanced").AdvancedMetadataPatch
  ): Promise<void> {
    if (!/^[1-9]\d*$/.test(itemId) || !Number.isSafeInteger(Number(itemId)))
      throw Error("Invalid Plex item ID")
    return this.api.editAdvancedMetadata(
      this.requireSection(),
      Number(itemId),
      kind,
      patch
    )
  }
  async editMetadata(
    kind: "artist" | "album",
    itemId: string,
    patch: LibraryMetadataPatch,
    expected: LibraryMetadataExpected
  ): Promise<void> {
    if (!/^[1-9]\d*$/.test(itemId) || !Number.isSafeInteger(Number(itemId)))
      throw new Error("Invalid Plex item ID")
    await this.api.editLibraryMetadata(
      this.requireSection(),
      Number(itemId),
      kind,
      patch,
      expected
    )
  }

  async editPlaylist(
    playlistId: string,
    title?: string,
    summary?: string
  ): Promise<void> {
    await this.api.editPlaylist(Number(playlistId), title, summary)
  }

  async getArtworkInventory(
    kind: "artist" | "album",
    itemId: string,
    role: "poster" | "background"
  ): Promise<LibraryArtworkInventory> {
    if (!/^[1-9]\d*$/.test(itemId) || !Number.isSafeInteger(Number(itemId)))
      throw new Error("Invalid Plex item ID")
    return this.api.getLibraryArtwork(
      this.requireSection(),
      Number(itemId),
      kind,
      role
    )
  }
  async saveArtwork(
    kind: "artist" | "album",
    itemId: string,
    role: "poster" | "background",
    baseline: string,
    change: { choice: string } | { upload: number[] }
  ): Promise<LibraryArtworkInventory> {
    if (!/^[1-9]\d*$/.test(itemId) || !Number.isSafeInteger(Number(itemId)))
      throw new Error("Invalid Plex item ID")
    return this.api.saveLibraryArtwork(
      this.requireSection(),
      Number(itemId),
      kind,
      role,
      baseline,
      change
    )
  }

  async movePlaylistItem(
    playlistId: string,
    itemId: string,
    afterItemId: string
  ): Promise<void> {
    await this.api.movePlaylistItem(
      Number(playlistId),
      Number(itemId),
      Number(afterItemId)
    )
  }

  // ---------------------------------------------------------------------------
  // Liked
  // ---------------------------------------------------------------------------

  async getRatedItemsPage(kind: "track" | "album" | "artist", offset: number, limit: number): Promise<PagedResult<MusicItem>> {
    const page = await this.api.getRatedItemsPage(this.requireSection(), kind, offset, limit)
    return { ...page, offset, items: page.items.map(item => plexMediaToMusicItem(item, this.img)).filter((item): item is MusicItem => !!item) }
  }

  async getMixTracksPage(key: string, offset: number, limit: number): Promise<PagedResult<MusicTrack>> {
    const page = await this.api.getMixTracksPage(key, offset, limit)
    return { ...page, items: this.mapTracks(page.items) }
  }

  async getLikedTracks(limit?: number): Promise<MusicTrack[]> {
    const sid = this.requireSection()
    const tracks = await this.api.getLikedTracks(sid, limit)
    return this.mapTracks(tracks)
  }

  async getLikedAlbums(limit?: number): Promise<MusicAlbum[]> {
    const sid = this.requireSection()
    const albums = await this.api.getLikedAlbums(sid, limit)
    return albums.map((a) => plexAlbumToMusicAlbum(a, this.img))
  }

  async getLikedArtists(limit?: number): Promise<MusicArtist[]> {
    const sid = this.requireSection()
    const artists = await this.api.getLikedArtists(sid, limit)
    return artists.map((a) => plexArtistToMusicArtist(a, this.img))
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  private async playbackTrack(
    track: MusicTrack,
    api: PlexApi
  ): Promise<{ data: Track; fetched: boolean }> {
    const data = track._providerData as Track | undefined
    if (data && Array.isArray(data.media)) return { data, fetched: false }
    const id = Number(track.id)
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error("This saved track has no valid Plex playback identity.")
    try {
      // Browsing DTOs deliberately omit credentials/raw media. Only the owned
      // native request may restore authenticated playback metadata.
      const fresh = await api.getTrack(id)
      if (fresh.rating_key !== id || !Array.isArray(fresh.media))
        throw new Error("Invalid playback metadata")
      return { data: fresh, fetched: true }
    } catch {
      if (
        this._api !== api ||
        !this._connected ||
        this._cacheScope !== api.context.cacheScope
      )
        throw new Error("Plex connection was superseded")
      throw new Error(
        "Reconnect to Plex to load this track’s playback details. Saved pages do not include authenticated audio URLs."
      )
    }
  }

  async getStreamUrl(track: MusicTrack): Promise<string> {
    const api = this.api
    const raw = track._providerData as Track | undefined
    const { data: plexTrack } =
      raw && Array.isArray(raw.media)
        ? { data: raw }
        : await this.playbackTrack(track, api)
    const idx = pickBestMediaIndex(plexTrack.media ?? [])
    const partKey = plexTrack.media?.[idx]?.parts?.[0]?.key
    if (!partKey) throw new Error("Track has no media part")
    return api.getStreamUrl(partKey)
  }

  async getPlaybackInfo(track: MusicTrack): Promise<TrackPlaybackInfo> {
    if (!/^[1-9]\d*$/.test(track.id) || !Number.isSafeInteger(Number(track.id)))
      throw new Error("Invalid Plex track")
    return this.api.prepareTrackAudio(
      Number(track.id),
      track.mediaInfo?.localAudio === true
    )
  }

  async getTranscodePlaybackInfo(
    track: MusicTrack,
    bitrate = 320,
    codec = "mp3"
  ): Promise<TrackPlaybackInfo> {
    const api = this.api
    const raw = track._providerData as Track | undefined
    const { data } =
      raw && Array.isArray(raw.media)
        ? { data: raw }
        : await this.playbackTrack(track, api)
    const media = data.media?.[pickBestMediaIndex(data.media ?? [])]
    const part = media?.parts?.[0]
    if (!part?.key) throw new Error("Track has no media part")
    return {
      url: await api.getAudioTranscodeUrl(part.key, bitrate, codec),
      plexContext: api.context,
      trackKey: Number(track.id),
      partId: part.id ?? 0,
      parentKey: data.parent_key ?? "",
      startRamp: null,
      endRamp: null,
    }
  }

  async rate(itemId: string, rating: number | null): Promise<void> {
    await this.api.rateItem(Number(itemId), rating)
  }

  async markPlayed(trackId: string): Promise<void> {
    await this.api.markPlayed(Number(trackId))
  }

  async reportProgress(
    trackId: string,
    positionMs: number,
    state: string,
    duration: number
  ): Promise<void> {
    await this.api.reportTimeline(
      Number(trackId),
      state as "playing" | "paused" | "buffering" | "stopped",
      positionMs,
      duration
    )
  }

  // ---------------------------------------------------------------------------
  // Optional — stream levels, lyrics
  // ---------------------------------------------------------------------------

  async getStreamLevels(
    streamId: number,
    subSample?: number
  ): Promise<LevelData[]> {
    const levels = await this.api.getStreamLevels(streamId, subSample)
    return levels.map((l) => ({ loudness: l.loudness }))
  }

  async getTrackLevels(track: MusicTrack): Promise<LevelData[]> {
    return this.api.trackLevels(
      Number(track.id),
      track.mediaInfo?.localAudio === true
    )
  }

  async getLyrics(trackId: string): Promise<LyricLineData[]> {
    const lines = await this.api.getLyrics(Number(trackId))
    return lines.map((l) => ({
      startMs: l.start_ms,
      endMs: l.end_ms,
      text: l.text,
    }))
  }

  // ---------------------------------------------------------------------------
  // Optional — tags
  // ---------------------------------------------------------------------------

  async getTags(
    tagType: string
  ): Promise<{ tag: string; count: number | null }[]> {
    const sid = this.requireSection()
    return this.api.getSectionTags(sid, tagType)
  }

  async getItemsByTag(
    tagType: string,
    tagName: string,
    type?: string,
    limit?: number,
    offset?: number
  ): Promise<PagedResult<MusicItem>> {
    const sid = this.requireSection()
    const result = await this.api.getItemsByTag(
      sid,
      tagType as "genre" | "mood" | "style",
      tagName,
      type,
      limit,
      offset
    )
    return {
      items: result.items
        .map((m) => plexMediaToMusicItem(m, this.img))
        .filter((x): x is MusicItem => x !== null),
      total: result.total,
    }
  }

  // ---------------------------------------------------------------------------
  // Optional — mix tracks
  // ---------------------------------------------------------------------------

  async getMixTracks(mixKey: string): Promise<MusicTrack[]> {
    return (await this.getMixTracksPage(mixKey, 0, 200)).items
  }

  // ---------------------------------------------------------------------------
  // Optional — stations
  // ---------------------------------------------------------------------------

  async getSectionStations(): Promise<MusicHub[]> {
    const sid = this.requireSection()
    const hubs = await this.api.getSectionStations(sid)
    return hubs.map((h) => plexHubToMusicHub(h, this.img))
  }

  async getArtistStations(artistId: string): Promise<MusicPlaylist[]> {
    const stations = await this.api.getArtistStations(Number(artistId))
    return stations.map((p) => plexPlaylistToMusicPlaylist(p, this.img))
  }

  // ---------------------------------------------------------------------------
  // Optional — radio / play queue / sonic
  // ---------------------------------------------------------------------------

  async createRadioQueue(
    seedId: string,
    seedType: string,
    degreesOfSeparation?: number
  ): Promise<{ queueId: number; tracks: MusicTrack[] }> {
    const pq = await this.api.createRadioQueue(
      Number(seedId),
      seedType,
      degreesOfSeparation
    )
    return { queueId: pq.id, tracks: this.mapTracks(pq.items) }
  }

  async createSmartShuffleQueue(
    seedId: string,
    seedType: string,
    djMode?: string,
    degreesOfSeparation?: number
  ): Promise<{ queueId: number; tracks: MusicTrack[] }> {
    const pq = await this.api.createSmartShuffleQueue(
      Number(seedId),
      seedType,
      djMode,
      degreesOfSeparation
    )
    return { queueId: pq.id, tracks: this.mapTracks(pq.items) }
  }

  async createPlayQueue(
    uri: string,
    shuffle?: boolean,
    repeat?: number
  ): Promise<{ queueId: number; tracks: MusicTrack[] }> {
    const pq = await this.api.createPlayQueue(
      uri,
      shuffle ?? false,
      repeat ?? 0
    )
    return { queueId: pq.id, tracks: this.mapTracks(pq.items) }
  }

  async computeSonicPath(
    startId: string,
    endId: string
  ): Promise<MusicTrack[]> {
    const sid = this.requireSection()
    const tracks = await this.api.computeSonicPath(
      sid,
      Number(startId),
      Number(endId)
    )
    return this.mapTracks(tracks)
  }

  async getSonicallySimilar(
    itemId: string,
    limit?: number,
    maxDistance?: number
  ): Promise<MusicArtist[]> {
    const artists = await this.api.getArtistSonicallySimilar(
      Number(itemId),
      limit,
      maxDistance
    )
    return artists.map((a) => plexArtistToMusicArtist(a, this.img))
  }

  async getArtistSonicallySimilar(
    artistId: string,
    limit?: number,
    maxDistance?: number
  ): Promise<MusicArtist[]> {
    const artists = await this.api.getArtistSonicallySimilar(
      Number(artistId),
      limit,
      maxDistance
    )
    return artists.map((a) => plexArtistToMusicArtist(a, this.img))
  }

  private async cataloguePage(
    kind: "artist" | "album" | "track",
    offset = 0,
    limit = 200
  ): Promise<PagedResult<MusicItem>> {
    const page = await this.api.cataloguePage(kind, offset, limit)
    const items = page.items
      .map((item) => plexMediaToMusicItem(item, this.img))
      .filter((item): item is MusicItem => item !== null)
      .map((item) => ({ ...item, _providerData: undefined }))
    return { ...page, items }
  }
  async getAllArtists(
    offset = 0,
    limit = 200
  ): Promise<PagedResult<MusicArtist>> {
    return this.cataloguePage("artist", offset, limit) as Promise<
      PagedResult<MusicArtist>
    >
  }
  async getAllAlbums(
    offset = 0,
    limit = 200
  ): Promise<PagedResult<MusicAlbum>> {
    return this.cataloguePage("album", offset, limit) as Promise<
      PagedResult<MusicAlbum>
    >
  }
  async getAllTracks(
    offset = 0,
    limit = 200
  ): Promise<PagedResult<MusicTrack>> {
    return this.cataloguePage("track", offset, limit) as Promise<
      PagedResult<MusicTrack>
    >
  }

  async getArtistTracks(artistId: string): Promise<MusicTrack[]> {
    const albums = await this.getArtistAlbumsInSection(artistId)
    const tracks: MusicTrack[] = []
    const seen = new Set<string>()
    for (const album of albums) {
      for (const track of await this.getAlbumTracks(album.id)) {
        if (track.artistId === artistId && !seen.has(track.id)) {
          seen.add(track.id)
          tracks.push(track)
        }
      }
    }
    return tracks
  }

  async getArtistPopularTracksInSection(
    artistId: string,
    limit?: number
  ): Promise<MusicTrack[]> {
    const sid = this.requireSection()
    const tracks = await this.api.getArtistPopularTracksInSection(
      sid,
      Number(artistId),
      limit
    )
    return this.mapTracks(tracks)
  }

  async getArtistAlbumsInSection(
    artistId: string,
    formatFilter?: string
  ): Promise<MusicAlbum[]> {
    const sid = this.requireSection()
    const albums = await this.api.getArtistAlbumsInSection(
      sid,
      Number(artistId),
      formatFilter
    )
    return albums.map((a) => plexAlbumToMusicAlbum(a, this.img))
  }

  // ---------------------------------------------------------------------------
  // URI builders
  // ---------------------------------------------------------------------------

  buildItemUri(itemKey: string): string {
    if (!this._sectionUuid) throw new Error("PlexProvider: no section UUID")
    return plex.buildItemUri(this._sectionUuid, itemKey)
  }

  buildDirectoryUri(itemKey: string): string {
    if (!this._sectionUuid) throw new Error("PlexProvider: no section UUID")
    return plex.buildDirectoryUri(this._sectionUuid, itemKey)
  }

  buildRadioUri(stationKey: string): string {
    if (!this._sectionUuid) throw new Error("PlexProvider: no section UUID")
    return plex.buildRadioPlayQueueUri(this._sectionUuid, stationKey)
  }

  buildPlaylistUri(playlistKey: string): string {
    if (!this._machineIdentifier)
      throw new Error("PlexProvider: no machine identifier")
    return plex.buildPlaylistUri(this._machineIdentifier, playlistKey)
  }

  buildTagFilterUri(tagType: string, tagValue: string): string {
    if (!this._sectionUuid || this._sectionId === null)
      throw new Error("PlexProvider: no section")
    return plex.buildTagFilterUri(
      this._sectionUuid,
      this._sectionId,
      tagType as "genre" | "mood" | "style",
      tagValue
    )
  }

  // ---------------------------------------------------------------------------
  // Now Playing / OS integration
  // ---------------------------------------------------------------------------

  async updateNowPlaying(
    title: string,
    artist: string,
    album: string,
    thumbPath: string | null,
    durationMs: number
  ): Promise<void> {
    await this.api.updateNowPlaying(title, artist, album, thumbPath, durationMs)
  }

  async setNowPlayingState(
    state: "playing" | "paused" | "stopped",
    positionMs?: number
  ): Promise<void> {
    await this.api.setNowPlayingState(state, positionMs)
  }

  // ---------------------------------------------------------------------------
  // Track lifecycle hooks — scrobbling to Last.fm + ListenBrainz
  // ---------------------------------------------------------------------------

  onTrackStart(track: MusicTrack, isCurrent: () => boolean = () => true): void {
    const generation = ++this.nowPlayingGeneration
    lastfmUpdateNowPlaying(
      track.artistName ?? "",
      track.title,
      track.albumName ?? "",
      track.artistName ?? "",
      track.duration ?? 0
    ).catch(() => {})

    // Resolve MBIDs (cached or fresh) then submit to ListenBrainz
    resolveTrackMbids(track)
      .then((mbids) => {
        if (generation !== this.nowPlayingGeneration || !isCurrent()) return
        listenbrainzSubmitNowPlaying(
          track.artistName ?? "",
          track.title,
          track.albumName ?? "",
          track.duration ?? 0,
          mbids
        ).catch(() => {})
      })
      .catch(() => {})
  }
}

/**
 * Resolve MusicBrainz IDs for a track — checks Plex GUID first, then falls
 * back to the MusicBrainz recording lookup (cached in IndexedDB with 30-day TTL).
 *
 * Returns undefined if no MBIDs could be resolved (ListenBrainz will still
 * accept the submission, just without MBID matching).
 */
async function resolveTrackMbids(
  track: MusicTrack
): Promise<ListenBrainzMbids | undefined> {
  const artist = track.artistName ?? ""
  const title = track.title
  const album = track.albumName ?? ""

  if (!artist || !title) return undefined

  // Check if Plex already provided an MBID in the guid field.
  // Plex GUIDs can be: "mbid://recording/xxxxxxxx-..." or "plex://track/..."
  const plexGuid = track.guid ?? ""
  if (plexGuid.startsWith("mbid://")) {
    // Extract the recording MBID from the Plex GUID — it's the UUID after the path segment
    const match = plexGuid.match(/mbid:\/\/\w+\/([0-9a-f-]{36})/)
    if (match) {
      // We have the recording MBID from Plex, but still look up artist/release MBIDs
      // from MusicBrainz for a more complete submission
      const mbidData = await useMbidStore
        .getState()
        .lookup(artist, title, album)
      if (mbidData) {
        return {
          recordingMbid: mbidData.recording_mbid || match[1],
          artistMbids: mbidData.artist_mbids,
          releaseMbid: mbidData.release_mbid ?? undefined,
          releaseGroupMbid: mbidData.release_group_mbid ?? undefined,
        }
      }
      return { recordingMbid: match[1] }
    }
  }

  // Plex doesn't have an MBID — look it up from MusicBrainz
  const mbidData = await useMbidStore.getState().lookup(artist, title, album)
  if (!mbidData) return undefined

  return {
    recordingMbid: mbidData.recording_mbid,
    artistMbids: mbidData.artist_mbids,
    releaseMbid: mbidData.release_mbid ?? undefined,
    releaseGroupMbid: mbidData.release_group_mbid ?? undefined,
  }
}
