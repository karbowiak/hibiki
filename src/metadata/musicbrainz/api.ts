/**
 * MusicBrainz public API — TypeScript wrappers around Tauri invoke() calls.
 *
 * No API key or authentication required. All data is public.
 * Results should be cached by the caller (see musicbrainzMetadataStore).
 */

import { invoke } from "@tauri-apps/api/core"

export interface MusicBrainzArtistInfo {
  mbid: string
  name: string
  artist_type: string | null
  area: string | null
  tags: string[]
  begin_date: string | null
  wikipedia_url: string | null
  wikidata_url?: string | null
}

export interface MusicBrainzAlbumInfo {
  artist?: string
  mbid: string
  title: string
  release_type: string | null
  first_release_date: string | null
  tags: string[]
}

/** Search for an artist by name. Returns the best match or null if not found. */
export const musicbrainzGetArtistInfo = (
  artist: string
): Promise<MusicBrainzArtistInfo | null> =>
  invoke("musicbrainz_get_artist_info", { artist })

/** Search for an album by artist + title. Returns the best match or null if not found. */
export const musicbrainzGetAlbumInfo = (
  artist: string,
  album: string
): Promise<MusicBrainzAlbumInfo | null> =>
  invoke("musicbrainz_get_album_info", { artist, album })

export interface MusicBrainzRecordingMbids {
  recording_mbid: string
  artist_mbids: string[]
  release_mbid: string | null
  release_group_mbid: string | null
}

/** Look up MBIDs for a recording by artist + track + album. Used for ListenBrainz submissions. */
export const musicbrainzLookupRecording = (
  artist: string,
  track: string,
  album: string
): Promise<MusicBrainzRecordingMbids | null> =>
  invoke("musicbrainz_lookup_recording", { artist, track, album })
