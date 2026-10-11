/**
 * PlexProvider — wraps lib/plex.ts calls behind the MusicProvider interface.
 *
 * Holds sectionId, sectionUuid, baseUrl, and token internally.
 * Mappers convert Plex types to generic types, resolving image URLs during conversion.
 */

import { providerCacheScope } from "../../lib/providerCacheScope"
import { canScrobble } from "../../audio/playbackJournal"
import type { MusicProvider, ProviderCapabilities, LevelData, LyricLineData, TrackPlaybackInfo } from "../../providers/types"
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
import { lastfmScrobble, lastfmUpdateNowPlaying } from "../../metadata/lastfm/api"
import { listenbrainzSubmitNowPlaying, listenbrainzSubmitListen, type ListenBrainzMbids } from "../../metadata/listenbrainz/api"
import { useMbidStore } from "../../metadata/musicbrainz/mbidStore"
import { buildPlexImageUrl } from "./imageUrl"
import { pickBestMediaIndex } from "../../lib/dedup"

export class PlexProvider implements MusicProvider {
  constructor(private transport?: PlexTransport) {}
  readonly name = "Plex"
  readonly capabilities: ProviderCapabilities = {
    search: true,
    playlists: true,
    playlistEdit: true,
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
  get cacheScope() { return this._cacheScope }

  private _connected = false
  private _connectionGeneration = 0
  private _api: PlexApi | null = null
  private get api(): PlexApi {
    if (!this._connected || !this._api) throw new Error("Plex provider is disconnected")
    return this._api
  }
  private _baseUrl = ""
  private _token = ""
  private _sectionId: number | null = null
  private _sectionUuid: string | null = null
  private _machineIdentifier = ""

  get playbackSession(): unknown { return this._api }
  get sectionId(): number | null { return this._sectionId }
  get sectionUuid(): string | null { return this._sectionUuid }
  get baseUrl(): string { return this._baseUrl }
  get token(): string { return this._token }
  get machineIdentifier(): string { return this._machineIdentifier }

  /** Image resolver bound to current connection credentials. */
  private img: ImgResolver = () => ""

  private rebuildImg() {
    const base = this._baseUrl
    const token = this._token
    const scope = this._cacheScope
    this.img = (path, entityType, entityId, name, artist) =>
      buildPlexImageUrl(base, token, entityType, entityId, path, name, artist, scope) ?? ""
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
    const scope = typeof config.cacheScope === "string" && /^plex-[a-f0-9]{64}$/.test(config.cacheScope)
      ? config.cacheScope
      : await providerCacheScope("plex", (config.machineIdentifier as string) ?? "", token, sectionUuid || String(sectionId), baseUrl)
    if (generation !== this._connectionGeneration) throw new Error("Plex connection was superseded")
    this._api = createPlexApi({
      connectionRevision: config.connectionRevision as number,
      cacheScope: scope,
    }, this.transport, () => this._connected && generation === this._connectionGeneration)

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

  getLibrarySections(): Promise<LibrarySection[]> {
    return this.api.getLibrarySections()
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private requireSection(): number {
    if (this._sectionId === null) throw new Error("PlexProvider: no music section selected")
    return this._sectionId
  }

  private mapTrack = (t: Track): MusicTrack => plexTrackToMusicTrack(t, this.img)
  private mapTracks = (ts: Track[]): MusicTrack[] => ts.map(this.mapTrack)

  // ---------------------------------------------------------------------------
  // Browse
  // ---------------------------------------------------------------------------

  async search(query: string, type?: "track" | "album" | "artist"): Promise<MusicItem[]> {
    const sid = this.requireSection()
    const libtype = type === "track" ? "10" : type === "album" ? "9" : type === "artist" ? "8" : undefined
    const results = await this.api.searchLibrary(sid, query, libtype)
    return results
      .map(m => plexMediaToMusicItem(m, this.img))
      .filter((x): x is MusicItem => x !== null)
  }

  async getRecentlyAdded(type?: string, limit?: number): Promise<MusicItem[]> {
    const sid = this.requireSection()
    const items = await this.api.getRecentlyAdded(sid, type, limit)
    return items
      .map(m => plexMediaToMusicItem(m, this.img))
      .filter((x): x is MusicItem => x !== null)
  }

  async getHubs(): Promise<MusicHub[]> {
    const sid = this.requireSection()
    const hubs = await this.api.getHubs(sid)
    return hubs.map(h => plexHubToMusicHub(h, this.img))
  }

  // ---------------------------------------------------------------------------
  // Library
  // ---------------------------------------------------------------------------

  async getTrack(id: string): Promise<MusicTrack> {
    const t = await this.api.getTrack(Number(id))
    const track = plexTrackToMusicTrack(t, this.img)
    track.mediaInfo = {...track.mediaInfo, metadataComplete: true}
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

  async getArtistAlbums(artistId: string, formatFilter?: string): Promise<MusicAlbum[]> {
    const albums = await this.api.getArtistAlbums(Number(artistId), formatFilter)
    return albums.map(a => plexAlbumToMusicAlbum(a, this.img))
  }

  async getArtistPopularTracks(artistId: string, limit?: number): Promise<MusicTrack[]> {
    const tracks = await this.api.getArtistPopularTracks(Number(artistId), limit)
    return this.mapTracks(tracks)
  }

  async getArtistSimilar(artistId: string): Promise<MusicArtist[]> {
    const artists = await this.api.getArtistSimilar(Number(artistId))
    return artists.map(a => plexArtistToMusicArtist(a, this.img))
  }

  async getRelatedHubs(itemId: string): Promise<MusicHub[]> {
    const hubs = await this.api.getRelatedHubs(Number(itemId))
    return hubs.map(h => plexHubToMusicHub(h, this.img))
  }

  // ---------------------------------------------------------------------------
  // Playlists
  // ---------------------------------------------------------------------------

  async getPlaylists(): Promise<MusicPlaylist[]> {
    const sid = this.requireSection()
    const playlists = await this.api.getPlaylists(sid)
    return playlists.map(p => plexPlaylistToMusicPlaylist(p, this.img))
  }

  async getPlaylistItems(playlistId: string, offset?: number, limit?: number): Promise<PagedResult<MusicTrack>> {
    const tracks = await this.api.getPlaylistItems(Number(playlistId), limit, offset)
    return {
      items: this.mapTracks(tracks),
      total: tracks.length, // Plex doesn't return total separately in this endpoint
    }
  }

  async createPlaylist(title: string, itemIds: string[]): Promise<MusicPlaylist> {
    const sid = this.requireSection()
    const p = await this.api.createPlaylist(title, sid, itemIds.map(Number))
    return plexPlaylistToMusicPlaylist(p, this.img)
  }

  async addToPlaylist(playlistId: string, itemIds: string[]): Promise<void> {
    await this.api.addItemsToPlaylist(Number(playlistId), itemIds.map(Number))
  }

  async removeFromPlaylist(playlistId: string, playlistItemIds: string[]): Promise<void> {
    await this.api.removeItemsFromPlaylist(Number(playlistId), playlistItemIds.map(Number))
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    await this.api.deletePlaylist(Number(playlistId))
  }

  async editPlaylist(playlistId: string, title?: string, summary?: string): Promise<void> {
    await this.api.editPlaylist(Number(playlistId), title, summary)
  }

  async movePlaylistItem(playlistId: string, itemId: string, afterItemId: string): Promise<void> {
    await this.api.movePlaylistItem(Number(playlistId), Number(itemId), Number(afterItemId))
  }

  // ---------------------------------------------------------------------------
  // Liked
  // ---------------------------------------------------------------------------

  async getLikedTracks(limit?: number): Promise<MusicTrack[]> {
    const sid = this.requireSection()
    const tracks = await this.api.getLikedTracks(sid, limit)
    return this.mapTracks(tracks)
  }

  async getLikedAlbums(limit?: number): Promise<MusicAlbum[]> {
    const sid = this.requireSection()
    const albums = await this.api.getLikedAlbums(sid, limit)
    return albums.map(a => plexAlbumToMusicAlbum(a, this.img))
  }

  async getLikedArtists(limit?: number): Promise<MusicArtist[]> {
    const sid = this.requireSection()
    const artists = await this.api.getLikedArtists(sid, limit)
    return artists.map(a => plexArtistToMusicArtist(a, this.img))
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  async getStreamUrl(track: MusicTrack): Promise<string> {
    const plexTrack = track._providerData as Track
    const idx = pickBestMediaIndex(plexTrack.media ?? [])
    const partKey = plexTrack.media?.[idx]?.parts?.[0]?.key
    if (!partKey) throw new Error("Track has no media part")
    return this.api.getStreamUrl(partKey)
  }

  async getPlaybackInfo(track: MusicTrack): Promise<TrackPlaybackInfo> {
    const api = this.api
    let plexTrack = track._providerData as Track
    let idx = pickBestMediaIndex(plexTrack.media ?? [])
    let media = plexTrack.media?.[idx]
    let stream = media?.parts?.[0]?.streams?.find(s => s.stream_type === 2)

    // Re-fetch if ramps are missing — cached _providerData may predate includeLoudnessRamps
    if (!track.mediaInfo?.metadataComplete && !stream?.start_ramp && !stream?.end_ramp) {
      try {
        plexTrack = await api.getTrack(Number(track.id))
        idx = pickBestMediaIndex(plexTrack.media ?? [])
        media = plexTrack.media?.[idx]
        stream = media?.parts?.[0]?.streams?.find(s => s.stream_type === 2)
      } catch { /* use original data */ }
    }

    const partKey = media?.parts?.[0]?.key
    if (!partKey) throw new Error("Track has no media part")
    return {
      url: await api.getStreamUrl(partKey),
      plexContext: api.context,
      trackKey: Number(track.id),
      partId: media?.parts?.[0]?.id ?? 0,
      parentKey: plexTrack.parent_key ?? "",
      startRamp: stream?.start_ramp ?? plexTrack.start_ramp ?? null,
      endRamp: stream?.end_ramp ?? plexTrack.end_ramp ?? null,
    }
  }

  async getTranscodePlaybackInfo(track: MusicTrack, bitrate = 320, codec = "mp3"): Promise<TrackPlaybackInfo> {
    const api = this.api
    const data = track._providerData as Track | undefined
    const media = data?.media?.[pickBestMediaIndex(data.media)]
    const part = media?.parts?.[0]
    if (!part?.key) throw new Error("Track has no media part")
    return {
      url: await api.getAudioTranscodeUrl(part.key, bitrate, codec),
      plexContext: api.context,
      trackKey: Number(track.id), partId: part.id ?? 0,
      parentKey: data.parent_key ?? "", startRamp: null, endRamp: null,
    }
  }

  async rate(itemId: string, rating: number | null): Promise<void> {
    await this.api.rateItem(Number(itemId), rating)
  }

  async markPlayed(trackId: string): Promise<void> {
    await this.api.markPlayed(Number(trackId))
  }

  async reportProgress(trackId: string, positionMs: number, state: string, duration: number): Promise<void> {
    await this.api.reportTimeline(
      Number(trackId),
      state as "playing" | "paused" | "buffering" | "stopped",
      positionMs,
      duration,
    )
  }

  // ---------------------------------------------------------------------------
  // Optional — stream levels, lyrics
  // ---------------------------------------------------------------------------

  async getStreamLevels(streamId: number, subSample?: number): Promise<LevelData[]> {
    const levels = await this.api.getStreamLevels(streamId, subSample)
    return levels.map(l => ({ loudness: l.loudness }))
  }

  async getLyrics(trackId: string): Promise<LyricLineData[]> {
    const lines = await this.api.getLyrics(Number(trackId))
    return lines.map(l => ({ startMs: l.start_ms, endMs: l.end_ms, text: l.text }))
  }

  // ---------------------------------------------------------------------------
  // Optional — tags
  // ---------------------------------------------------------------------------

  async getTags(tagType: string): Promise<{ tag: string; count: number | null }[]> {
    const sid = this.requireSection()
    return this.api.getSectionTags(sid, tagType)
  }

  async getItemsByTag(tagType: string, tagName: string, type?: string, limit?: number, offset?: number): Promise<PagedResult<MusicItem>> {
    const sid = this.requireSection()
    const result = await this.api.getItemsByTag(
      sid,
      tagType as "genre" | "mood" | "style",
      tagName,
      type,
      limit,
      offset,
    )
    return {
      items: result.items
        .map(m => plexMediaToMusicItem(m, this.img))
        .filter((x): x is MusicItem => x !== null),
      total: result.total,
    }
  }

  // ---------------------------------------------------------------------------
  // Optional — mix tracks
  // ---------------------------------------------------------------------------

  async getMixTracks(mixKey: string): Promise<MusicTrack[]> {
    const tracks = await this.api.getMixTracks(mixKey)
    return this.mapTracks(tracks)
  }

  // ---------------------------------------------------------------------------
  // Optional — stations
  // ---------------------------------------------------------------------------

  async getSectionStations(): Promise<MusicHub[]> {
    const sid = this.requireSection()
    const hubs = await this.api.getSectionStations(sid)
    return hubs.map(h => plexHubToMusicHub(h, this.img))
  }

  async getArtistStations(artistId: string): Promise<MusicPlaylist[]> {
    const stations = await this.api.getArtistStations(Number(artistId))
    return stations.map(p => plexPlaylistToMusicPlaylist(p, this.img))
  }

  // ---------------------------------------------------------------------------
  // Optional — radio / play queue / sonic
  // ---------------------------------------------------------------------------

  async createRadioQueue(seedId: string, seedType: string, degreesOfSeparation?: number): Promise<{ queueId: number; tracks: MusicTrack[] }> {
    const pq = await this.api.createRadioQueue(Number(seedId), seedType, degreesOfSeparation)
    return { queueId: pq.id, tracks: this.mapTracks(pq.items) }
  }

  async createSmartShuffleQueue(seedId: string, seedType: string, djMode?: string, degreesOfSeparation?: number): Promise<{ queueId: number; tracks: MusicTrack[] }> {
    const pq = await this.api.createSmartShuffleQueue(Number(seedId), seedType, djMode, degreesOfSeparation)
    return { queueId: pq.id, tracks: this.mapTracks(pq.items) }
  }

  async createPlayQueue(uri: string, shuffle?: boolean, repeat?: number): Promise<{ queueId: number; tracks: MusicTrack[] }> {
    const pq = await this.api.createPlayQueue(uri, shuffle ?? false, repeat ?? 0)
    return { queueId: pq.id, tracks: this.mapTracks(pq.items) }
  }

  async computeSonicPath(startId: string, endId: string): Promise<MusicTrack[]> {
    const sid = this.requireSection()
    const tracks = await this.api.computeSonicPath(sid, Number(startId), Number(endId))
    return this.mapTracks(tracks)
  }

  async getSonicallySimilar(itemId: string, limit?: number, maxDistance?: number): Promise<MusicArtist[]> {
    const artists = await this.api.getArtistSonicallySimilar(Number(itemId), limit, maxDistance)
    return artists.map(a => plexArtistToMusicArtist(a, this.img))
  }

  async getArtistSonicallySimilar(artistId: string, limit?: number, maxDistance?: number): Promise<MusicArtist[]> {
    const artists = await this.api.getArtistSonicallySimilar(Number(artistId), limit, maxDistance)
    return artists.map(a => plexArtistToMusicArtist(a, this.img))
  }

  async getArtistPopularTracksInSection(artistId: string, limit?: number): Promise<MusicTrack[]> {
    const sid = this.requireSection()
    const tracks = await this.api.getArtistPopularTracksInSection(sid, Number(artistId), limit)
    return this.mapTracks(tracks)
  }

  async getArtistAlbumsInSection(artistId: string, formatFilter?: string): Promise<MusicAlbum[]> {
    const sid = this.requireSection()
    const albums = await this.api.getArtistAlbumsInSection(sid, Number(artistId), formatFilter)
    return albums.map(a => plexAlbumToMusicAlbum(a, this.img))
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
    if (!this._machineIdentifier) throw new Error("PlexProvider: no machine identifier")
    return plex.buildPlaylistUri(this._machineIdentifier, playlistKey)
  }

  buildTagFilterUri(tagType: string, tagValue: string): string {
    if (!this._sectionUuid || this._sectionId === null) throw new Error("PlexProvider: no section")
    return plex.buildTagFilterUri(
      this._sectionUuid,
      this._sectionId,
      tagType as "genre" | "mood" | "style",
      tagValue,
    )
  }

  // ---------------------------------------------------------------------------
  // Now Playing / OS integration
  // ---------------------------------------------------------------------------

  async updateNowPlaying(title: string, artist: string, album: string, thumbPath: string | null, durationMs: number): Promise<void> {
    await this.api.updateNowPlaying(title, artist, album, thumbPath, durationMs)
  }

  async setNowPlayingState(state: "playing" | "paused" | "stopped", positionMs?: number): Promise<void> {
    await this.api.setNowPlayingState(state, positionMs)
  }

  // ---------------------------------------------------------------------------
  // Track lifecycle hooks — scrobbling to Last.fm + ListenBrainz
  // ---------------------------------------------------------------------------

  onTrackStart(track: MusicTrack): void {
    lastfmUpdateNowPlaying(
      track.artistName ?? "",
      track.title,
      track.albumName ?? "",
      track.artistName ?? "",
      track.duration ?? 0,
    ).catch(() => {})

    // Resolve MBIDs (cached or fresh) then submit to ListenBrainz
    resolveTrackMbids(track).then(mbids => {
      listenbrainzSubmitNowPlaying(
        track.artistName ?? "",
        track.title,
        track.albumName ?? "",
        track.duration ?? 0,
        mbids,
      ).catch(() => {})
    }).catch(() => {})
  }

  onTrackEnd(track: MusicTrack, startedAtUnix: number, listenedMs: number): void {
    if (!canScrobble(track.duration, listenedMs)) return;
    lastfmScrobble(
      track.artistName ?? "",
      track.title,
      track.albumName ?? "",
      track.artistName ?? "",
      track.duration ?? 0,
      startedAtUnix,
      listenedMs,
    ).catch(() => {})

    // Resolve MBIDs (likely already cached from onTrackStart) then submit
    resolveTrackMbids(track).then(mbids => {
      listenbrainzSubmitListen(
        track.artistName ?? "",
        track.title,
        track.albumName ?? "",
        track.duration ?? 0,
        startedAtUnix,
        mbids,
      ).catch(() => {})
    }).catch(() => {})
  }
}

/**
 * Resolve MusicBrainz IDs for a track — checks Plex GUID first, then falls
 * back to the MusicBrainz recording lookup (cached in IndexedDB with 30-day TTL).
 *
 * Returns undefined if no MBIDs could be resolved (ListenBrainz will still
 * accept the submission, just without MBID matching).
 */
async function resolveTrackMbids(track: MusicTrack): Promise<ListenBrainzMbids | undefined> {
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
      const mbidData = await useMbidStore.getState().lookup(artist, title, album)
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
