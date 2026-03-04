/**
 * PlexProvider — wraps lib/plex.ts calls behind the MusicProvider interface.
 *
 * Holds sectionId, sectionUuid, baseUrl, and token internally.
 * Mappers convert Plex types to generic types, resolving image URLs during conversion.
 */

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
import type { Track } from "./types"
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
import { lastfmScrobble, lastfmUpdateNowPlaying } from "../lastfm/api"
import { buildPlexImageUrl } from "./imageUrl"
import { pickBestMediaIndex } from "../../lib/dedup"

export class PlexProvider implements MusicProvider {
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

  private _connected = false
  private _baseUrl = ""
  private _token = ""
  private _sectionId: number | null = null
  private _sectionUuid: string | null = null

  get sectionId(): number | null { return this._sectionId }
  get sectionUuid(): string | null { return this._sectionUuid }
  get baseUrl(): string { return this._baseUrl }
  get token(): string { return this._token }

  /** Image resolver bound to current connection credentials. */
  private img: ImgResolver = () => ""

  private rebuildImg() {
    const base = this._baseUrl
    const token = this._token
    this.img = (path, entityType, entityId, name, artist) =>
      buildPlexImageUrl(base, token, entityType, entityId, path, name, artist) ?? ""
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  async connect(config: Record<string, unknown>): Promise<void> {
    const baseUrl = config.baseUrl as string
    const token = config.token as string
    const sectionId = config.sectionId as number
    const sectionUuid = (config.sectionUuid as string) ?? null

    this._baseUrl = baseUrl
    this._token = token
    this._sectionId = sectionId
    this._sectionUuid = sectionUuid
    this.rebuildImg()
    this._connected = true
  }

  async disconnect(): Promise<void> {
    this._connected = false
    this._sectionId = null
    this._sectionUuid = null
  }

  isConnected(): boolean {
    return this._connected
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

  async search(query: string): Promise<MusicItem[]> {
    const sid = this.requireSection()
    const results = await plex.searchLibrary(sid, query)
    return results
      .map(m => plexMediaToMusicItem(m, this.img))
      .filter((x): x is MusicItem => x !== null)
  }

  async getRecentlyAdded(type?: string, limit?: number): Promise<MusicItem[]> {
    const sid = this.requireSection()
    const items = await plex.getRecentlyAdded(sid, type, limit)
    return items
      .map(m => plexMediaToMusicItem(m, this.img))
      .filter((x): x is MusicItem => x !== null)
  }

  async getHubs(): Promise<MusicHub[]> {
    const sid = this.requireSection()
    const hubs = await plex.getHubs(sid)
    return hubs.map(h => plexHubToMusicHub(h, this.img))
  }

  // ---------------------------------------------------------------------------
  // Library
  // ---------------------------------------------------------------------------

  async getTrack(id: string): Promise<MusicTrack> {
    const t = await plex.getTrack(Number(id))
    return plexTrackToMusicTrack(t, this.img)
  }

  async getAlbum(id: string): Promise<MusicAlbum> {
    const a = await plex.getAlbum(Number(id))
    return plexAlbumToMusicAlbum(a, this.img)
  }

  async getArtist(id: string): Promise<MusicArtist> {
    const a = await plex.getArtist(Number(id))
    return plexArtistToMusicArtist(a, this.img)
  }

  async getAlbumTracks(albumId: string): Promise<MusicTrack[]> {
    const tracks = await plex.getAlbumTracks(Number(albumId))
    return this.mapTracks(tracks)
  }

  async getArtistAlbums(artistId: string, formatFilter?: string): Promise<MusicAlbum[]> {
    const albums = await plex.getArtistAlbums(Number(artistId), formatFilter)
    return albums.map(a => plexAlbumToMusicAlbum(a, this.img))
  }

  async getArtistPopularTracks(artistId: string, limit?: number): Promise<MusicTrack[]> {
    const tracks = await plex.getArtistPopularTracks(Number(artistId), limit)
    return this.mapTracks(tracks)
  }

  async getArtistSimilar(artistId: string): Promise<MusicArtist[]> {
    const artists = await plex.getArtistSimilar(Number(artistId))
    return artists.map(a => plexArtistToMusicArtist(a, this.img))
  }

  async getRelatedHubs(itemId: string): Promise<MusicHub[]> {
    const hubs = await plex.getRelatedHubs(Number(itemId))
    return hubs.map(h => plexHubToMusicHub(h, this.img))
  }

  // ---------------------------------------------------------------------------
  // Playlists
  // ---------------------------------------------------------------------------

  async getPlaylists(): Promise<MusicPlaylist[]> {
    const sid = this.requireSection()
    const playlists = await plex.getPlaylists(sid)
    return playlists.map(p => plexPlaylistToMusicPlaylist(p, this.img))
  }

  async getPlaylistItems(playlistId: string, offset?: number, limit?: number): Promise<PagedResult<MusicTrack>> {
    const tracks = await plex.getPlaylistItems(Number(playlistId), limit, offset)
    return {
      items: this.mapTracks(tracks),
      total: tracks.length, // Plex doesn't return total separately in this endpoint
    }
  }

  async createPlaylist(title: string, itemIds: string[]): Promise<MusicPlaylist> {
    const sid = this.requireSection()
    const p = await plex.createPlaylist(title, sid, itemIds.map(Number))
    return plexPlaylistToMusicPlaylist(p, this.img)
  }

  async addToPlaylist(playlistId: string, itemIds: string[]): Promise<void> {
    await plex.addItemsToPlaylist(Number(playlistId), itemIds.map(Number))
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    await plex.deletePlaylist(Number(playlistId))
  }

  async editPlaylist(playlistId: string, title?: string, summary?: string): Promise<void> {
    await plex.editPlaylist(Number(playlistId), title, summary)
  }

  // ---------------------------------------------------------------------------
  // Liked
  // ---------------------------------------------------------------------------

  async getLikedTracks(limit?: number): Promise<MusicTrack[]> {
    const sid = this.requireSection()
    const tracks = await plex.getLikedTracks(sid, limit)
    return this.mapTracks(tracks)
  }

  async getLikedAlbums(limit?: number): Promise<MusicAlbum[]> {
    const sid = this.requireSection()
    const albums = await plex.getLikedAlbums(sid, limit)
    return albums.map(a => plexAlbumToMusicAlbum(a, this.img))
  }

  async getLikedArtists(limit?: number): Promise<MusicArtist[]> {
    const sid = this.requireSection()
    const artists = await plex.getLikedArtists(sid, limit)
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
    return plex.getStreamUrl(partKey)
  }

  async getPlaybackInfo(track: MusicTrack): Promise<TrackPlaybackInfo> {
    const plexTrack = track._providerData as Track
    const idx = pickBestMediaIndex(plexTrack.media ?? [])
    const media = plexTrack.media?.[idx]
    const partKey = media?.parts?.[0]?.key
    if (!partKey) throw new Error("Track has no media part")
    return {
      url: `${this._baseUrl}${partKey}?X-Plex-Token=${this._token}`,
      trackKey: Number(track.id),
      partId: media?.parts?.[0]?.id ?? 0,
      parentKey: plexTrack.parent_key ?? "",
    }
  }

  async rate(itemId: string, rating: number | null): Promise<void> {
    await plex.rateItem(Number(itemId), rating)
  }

  async markPlayed(trackId: string): Promise<void> {
    await plex.markPlayed(Number(trackId))
  }

  async reportProgress(trackId: string, positionMs: number, state: string, duration: number): Promise<void> {
    await plex.reportTimeline(
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
    const levels = await plex.getStreamLevels(streamId, subSample)
    return levels.map(l => ({ loudness: l.loudness }))
  }

  async getLyrics(trackId: string): Promise<LyricLineData[]> {
    const lines = await plex.getLyrics(Number(trackId))
    return lines.map(l => ({ startMs: l.start_ms, endMs: l.end_ms, text: l.text }))
  }

  // ---------------------------------------------------------------------------
  // Optional — tags
  // ---------------------------------------------------------------------------

  async getTags(tagType: string): Promise<{ tag: string; count: number | null }[]> {
    const sid = this.requireSection()
    return plex.getSectionTags(sid, tagType)
  }

  async getItemsByTag(tagType: string, tagName: string, type?: string, limit?: number, offset?: number): Promise<PagedResult<MusicItem>> {
    const sid = this.requireSection()
    const result = await plex.getItemsByTag(
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
    const tracks = await plex.getMixTracks(mixKey)
    return this.mapTracks(tracks)
  }

  // ---------------------------------------------------------------------------
  // Optional — stations
  // ---------------------------------------------------------------------------

  async getSectionStations(): Promise<MusicHub[]> {
    const sid = this.requireSection()
    const hubs = await plex.getSectionStations(sid)
    return hubs.map(h => plexHubToMusicHub(h, this.img))
  }

  async getArtistStations(artistId: string): Promise<MusicPlaylist[]> {
    const stations = await plex.getArtistStations(Number(artistId))
    return stations.map(p => plexPlaylistToMusicPlaylist(p, this.img))
  }

  // ---------------------------------------------------------------------------
  // Optional — radio / play queue / sonic
  // ---------------------------------------------------------------------------

  async createRadioQueue(seedId: string, seedType: string, degreesOfSeparation?: number): Promise<{ queueId: number; tracks: MusicTrack[] }> {
    const pq = await plex.createRadioQueue(Number(seedId), seedType, degreesOfSeparation)
    return { queueId: pq.id, tracks: this.mapTracks(pq.items) }
  }

  async createSmartShuffleQueue(seedId: string, seedType: string, djMode?: string, degreesOfSeparation?: number): Promise<{ queueId: number; tracks: MusicTrack[] }> {
    const pq = await plex.createSmartShuffleQueue(Number(seedId), seedType, djMode, degreesOfSeparation)
    return { queueId: pq.id, tracks: this.mapTracks(pq.items) }
  }

  async createPlayQueue(uri: string, shuffle?: boolean, repeat?: number): Promise<{ queueId: number; tracks: MusicTrack[] }> {
    const pq = await plex.createPlayQueue(uri, shuffle ?? false, repeat ?? 0)
    return { queueId: pq.id, tracks: this.mapTracks(pq.items) }
  }

  async computeSonicPath(startId: string, endId: string): Promise<MusicTrack[]> {
    const sid = this.requireSection()
    const tracks = await plex.computeSonicPath(sid, Number(startId), Number(endId))
    return this.mapTracks(tracks)
  }

  async getSonicallySimilar(itemId: string, limit?: number, maxDistance?: number): Promise<MusicArtist[]> {
    const artists = await plex.getArtistSonicallySimilar(Number(itemId), limit, maxDistance)
    return artists.map(a => plexArtistToMusicArtist(a, this.img))
  }

  async getArtistSonicallySimilar(artistId: string, limit?: number, maxDistance?: number): Promise<MusicArtist[]> {
    const artists = await plex.getArtistSonicallySimilar(Number(artistId), limit, maxDistance)
    return artists.map(a => plexArtistToMusicArtist(a, this.img))
  }

  async getArtistPopularTracksInSection(artistId: string, limit?: number): Promise<MusicTrack[]> {
    const sid = this.requireSection()
    const tracks = await plex.getArtistPopularTracksInSection(sid, Number(artistId), limit)
    return this.mapTracks(tracks)
  }

  async getArtistAlbumsInSection(artistId: string, formatFilter?: string): Promise<MusicAlbum[]> {
    const sid = this.requireSection()
    const albums = await plex.getArtistAlbumsInSection(sid, Number(artistId), formatFilter)
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
    await plex.updateNowPlaying(title, artist, album, thumbPath, durationMs)
  }

  async setNowPlayingState(state: "playing" | "paused" | "stopped", positionMs?: number): Promise<void> {
    await plex.setNowPlayingState(state, positionMs)
  }

  // ---------------------------------------------------------------------------
  // Track lifecycle hooks — scrobbling to Last.fm
  // ---------------------------------------------------------------------------

  onTrackStart(track: MusicTrack): void {
    lastfmUpdateNowPlaying(
      track.artistName ?? "",
      track.title,
      track.albumName ?? "",
      track.artistName ?? "",
      track.duration ?? 0,
    ).catch(() => {})
  }

  onTrackEnd(track: MusicTrack, startedAtUnix: number, listenedMs: number): void {
    lastfmScrobble(
      track.artistName ?? "",
      track.title,
      track.albumName ?? "",
      track.artistName ?? "",
      track.duration ?? 0,
      startedAtUnix,
      listenedMs,
    ).catch(() => {})
  }
}
