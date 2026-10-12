/**
 * Plex-specific type mappers.
 *
 * Convert Plex API types (Track, Album, Artist, Playlist, Hub, PlexMedia)
 * into generic music types. Image URLs are resolved during mapping using
 * the supplied `img` helper — consumers never see raw Plex thumb paths.
 */

import type { Track, Album, Artist, Playlist, Hub, PlexMedia } from "./types"
import { pickBestMediaIndex } from "../../lib/dedup"
import type {
  MusicTrack,
  MusicAlbum,
  MusicArtist,
  MusicPlaylist,
  MusicItem,
  MusicHub,
  HubLayout,
} from "../../types/music"

/**
 * Image URL resolver — resolves a raw thumb path into a semantic image:// URL.
 *
 * @param path        Raw Plex thumb path
 * @param entityType  "artist" | "album" | "track" | "playlist"
 * @param entityId    Plex rating_key as string
 * @param name        Entity name for metadata fallback
 * @param artist      Artist name for album/track fallback
 */
export type ImgResolver = (
  path: string,
  entityType: "artist" | "album" | "track" | "playlist",
  entityId: string,
  name?: string | null,
  artist?: string | null,
) => string

function resolveImg(
  img: ImgResolver,
  path: string | null | undefined,
  entityType: "artist" | "album" | "track" | "playlist",
  entityId: string,
  name?: string | null,
  artist?: string | null,
): string | null {
  if (!path) return null
  return img(path, entityType, entityId, name, artist) || null
}

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

export function plexTrackToMusicTrack(t: Track, img: ImgResolver): MusicTrack {
  const media = t.media?.[pickBestMediaIndex(t.media ?? [])]
  const stream = media?.parts?.[0]?.streams?.find(s => s.stream_type === 2)
  const part = media?.parts?.[0]
  const trackId = String(t.rating_key)
  const albumId = t.parent_key ? String(t.parent_key.split("/").pop()) : null
  const artistId = t.grandparent_key ? String(t.grandparent_key.split("/").pop()) : null
  return {
    id: trackId,
    title: t.title,
    trackNumber: t.index,
    duration: t.duration,
    albumId,
    albumName: t.parent_title ?? "",
    albumYear: t.parent_year ?? null,
    artistId,
    artistName: t.grandparent_title ?? "",
    year: t.year,
    playCount: t.view_count ?? 0,
    thumbUrl: resolveImg(img, t.thumb || t.parent_thumb, "track", trackId, t.title, t.grandparent_title),
    albumThumbUrl: resolveImg(img, t.parent_thumb || t.thumb, "album", albumId ?? trackId, t.parent_title, t.grandparent_title),
    artistThumbUrl: resolveImg(img, t.grandparent_thumb, "artist", artistId ?? trackId, t.grandparent_title),
    summary: t.summary ?? null,
    userRating: t.user_rating ?? null,
    addedAt: t.added_at ?? null,
    lastPlayedAt: t.last_viewed_at ?? null,
    guid: t.guid ?? null,
    codec: stream?.codec ?? media?.audio_codec ?? t.audio_codec ?? null,
    bitrate: stream?.bitrate ?? media?.bitrate ?? t.audio_bitrate ?? null,
    channels: stream?.channels ?? media?.audio_channels ?? t.audio_channels ?? null,
    bitDepth: stream?.bit_depth ?? null,
    samplingRate: stream?.sampling_rate ?? null,
    streamUrl: null, // resolved lazily by provider.getStreamUrl()
    gain: stream?.gain ?? null,
    albumGain: stream?.album_gain ?? null,
    peak: stream?.peak ?? null,
    loudness: stream?.loudness ?? null,
    originalTitle: t.original_title ?? null,
    ratingCount: t.rating_count ?? null,
    parentStudio: t.parent_studio ?? null,
    lastRatedAt: t.last_rated_at ?? null,
    providerKey: t.key ?? null,
    startRamp: stream?.start_ramp ?? t.start_ramp ?? null,
    endRamp: stream?.end_ramp ?? t.end_ramp ?? null,
    rawThumbPath: t.thumb ?? t.parent_thumb ?? null,
    mediaInfo: {
      container: media?.container ?? null,
      fileSize: part?.size ?? null,
      audioStreamId: stream?.id ?? null,
      hasAudioStream: !!part?.key,
    },
    playlistItemId: t.playlist_item_id != null ? String(t.playlist_item_id) : null,
    _providerData: t,
  }
}

// ---------------------------------------------------------------------------
// Album
// ---------------------------------------------------------------------------

export function plexAlbumToMusicAlbum(a: Album, img: ImgResolver): MusicAlbum {
  const albumId = String(a.rating_key)
  const artistId = a.parent_key ? String(a.parent_key.split("/").pop()) : null
  return {
    id: albumId,
    title: a.title,
    artistId,
    artistName: a.parent_title ?? "",
    year: a.year,
    trackCount: a.leaf_count,
    studio: a.studio ?? null,
    thumbUrl: resolveImg(img, a.thumb, "album", albumId, a.title, a.parent_title),
    artistThumbUrl: resolveImg(img, a.parent_thumb, "artist", artistId ?? albumId, a.parent_title),
    summary: a.summary ?? null,
    userRating: a.user_rating ?? null,
    addedAt: a.added_at ?? null,
    releaseDate: a.originally_available_at ?? null,
    guid: a.guid ?? null,
    genres: (a.genre ?? []).map(t => t.tag),
    styles: (a.style ?? []).map(t => t.tag),
    moods: (a.mood ?? []).map(t => t.tag),
    labels: (a.label ?? []).map(t => t.tag),
    format: (a.subformat ?? []).length > 0 ? a.subformat[0].tag : null,
    providerKey: a.key ?? null,
    reviews: (a.reviews ?? []).map(r => ({
      tag: r.tag ?? null,
      text: r.text ?? null,
      source: r.source ?? null,
      image: r.image ?? null,
      link: r.link ?? null,
    })),
    _providerData: a,
  }
}

// ---------------------------------------------------------------------------
// Artist
// ---------------------------------------------------------------------------

export function plexArtistToMusicArtist(a: Artist, img: ImgResolver): MusicArtist {
  const artistId = String(a.rating_key)
  return {
    id: artistId,
    title: a.title,
    thumbUrl: resolveImg(img, a.thumb, "artist", artistId, a.title),
    artUrl: resolveImg(img, a.art, "artist", artistId, a.title),
    summary: a.summary ?? null,
    userRating: a.user_rating ?? null,
    addedAt: a.added_at ?? null,
    guid: a.guid ?? null,
    distance: a.distance ?? null,
    providerKey: a.key ?? null,
    _providerData: a,
  }
}

// ---------------------------------------------------------------------------
// Playlist
// ---------------------------------------------------------------------------

export function plexPlaylistToMusicPlaylist(p: Playlist, img: ImgResolver): MusicPlaylist {
  const playlistId = String(p.rating_key)
  return {
    id: playlistId,
    title: p.title,
    smart: p.smart,
    trackCount: p.leaf_count,
    duration: p.duration ?? null,
    thumbUrl: resolveImg(img, p.thumb || p.image || p.composite, "playlist", playlistId, p.title),
    summary: p.summary ?? null,
    addedAt: p.added_at ?? null,
    guid: p.guid ?? null,
    providerKey: p.key ?? null,
    _providerData: p,
  }
}

// ---------------------------------------------------------------------------
// PlexMedia (tagged union) → MusicItem
// ---------------------------------------------------------------------------

export function plexMediaToMusicItem(item: PlexMedia, img: ImgResolver): MusicItem | null {
  switch (item.type) {
    case "track":
      return { ...plexTrackToMusicTrack(item, img), type: "track" }
    case "album":
      return { ...plexAlbumToMusicAlbum(item, img), type: "album" }
    case "artist":
      return { ...plexArtistToMusicArtist(item, img), type: "artist" }
    case "playlist":
      return { ...plexPlaylistToMusicPlaylist(item, img), type: "playlist" }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

function deriveHubLayout(identifier: string, style: string | null): HubLayout {
  const id = identifier.toLowerCase()
  if (id.includes("mix") || id.includes("station")) return "hero"
  if (style === "pills" || id.includes("tag") || id.includes("genre") || id.includes("mood")) return "pills"
  return "scroller"
}

export function plexHubToMusicHub(h: Hub, img: ImgResolver): MusicHub {
  return {
    title: h.title,
    identifier: h.hub_identifier,
    items: h.metadata
      .map(m => plexMediaToMusicItem(m, img))
      .filter((x): x is MusicItem => x !== null),
    style: h.style ?? null,
    layout: deriveHubLayout(h.hub_identifier, h.style ?? null),
  }
}
