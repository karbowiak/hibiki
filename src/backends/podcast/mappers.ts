/**
 * Episode → MusicTrack mapper.
 *
 * Maps podcast episodes to MusicTrack objects so they can be played
 * through the existing audio engine and player store.
 */

import { buildExternalImageUrl } from "../../lib/imageUrl"
import type { MusicTrack } from "../../types/music"
import type { PodcastEpisode } from "./api"

/** Keep existing GUID progress keys; missing GUIDs use the actual enclosure. */
export function episodeProgressKey(episode: PodcastEpisode): string {
  return episode.guid || (episode.audio_url ? `audio:${episode.audio_url}` : `episode:${JSON.stringify([episode.title, episode.pub_date])}`)
}

/** Map a podcast episode to a MusicTrack for playback. */
export function episodeToTrack(
  episode: PodcastEpisode,
  podcastTitle: string,
  podcastAuthor: string,
  podcastArtworkUrl: string,
  feedUrl = "",
): MusicTrack {
  return {
    id: `pod-${JSON.stringify([feedUrl, episode.guid ? ["guid", episode.guid] : episode.audio_url ? ["enclosure", episode.audio_url] : ["metadata", episode.title, episode.pub_date]])}`,
    title: episode.title,
    trackNumber: episode.episode_number ?? 0,
    duration: episode.duration_secs * 1000, // ms
    albumId: null,
    albumName: podcastTitle,
    albumYear: null,
    artistId: null,
    artistName: podcastAuthor,
    year: 0,
    playCount: 0,
    thumbUrl: buildExternalImageUrl(episode.artwork_url || podcastArtworkUrl),
    albumThumbUrl: buildExternalImageUrl(podcastArtworkUrl),
    artistThumbUrl: null,
    summary: episode.description || null,
    userRating: null,
    addedAt: episode.pub_date || null,
    lastPlayedAt: null,
    guid: episode.guid || null,
    codec: episode.audio_type || null,
    bitrate: null,
    channels: null,
    bitDepth: null,
    samplingRate: null,
    streamUrl: episode.audio_url || null,
    gain: null,
    albumGain: null,
    peak: null,
    loudness: null,
    _providerData: {
      feedUrl,
      episodeGuid: episodeProgressKey(episode),
      isPodcast: true,
    },
  }
}

/** Map multiple episodes, setting the feedUrl on provider data. */
export function episodesToTracks(
  episodes: PodcastEpisode[],
  feedUrl: string,
  podcastTitle: string,
  podcastAuthor: string,
  podcastArtworkUrl: string,
): MusicTrack[] {
  return episodes
    .filter(ep => ep.audio_url) // only episodes with audio
    .map(ep => episodeToTrack(ep, podcastTitle, podcastAuthor, podcastArtworkUrl, feedUrl))
}

/** Check if a MusicTrack is a podcast episode. */
export function isPodcastTrack(track: MusicTrack): boolean {
  const pd = track._providerData as Record<string, unknown> | undefined
  return pd?.isPodcast === true
}
