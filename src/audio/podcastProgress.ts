import type { MusicTrack } from "../types/music"
import { usePodcastStore } from "../backends/podcast/store"

interface PodcastProgressRecord {
  track: MusicTrack
  podcastSavedAt: number
}

const PODCAST_PROGRESS_INTERVAL_MS = 5000
export function podcastIdentity(
  track: MusicTrack
): { feedUrl: string; guid: string } | null {
  const data = track._providerData as Record<string, unknown> | undefined
  return data?.isPodcast === true &&
    typeof data.feedUrl === "string" &&
    !!data.feedUrl &&
    typeof data.episodeGuid === "string" &&
    !!data.episodeGuid
    ? { feedUrl: data.feedUrl, guid: data.episodeGuid }
    : null
}
export function savePodcastProgress(
  record: PodcastProgressRecord | null,
  positionMs: number,
  force = false,
  completed = false
): void {
  if (!record || !Number.isFinite(positionMs) || positionMs < 0) return
  const identity = podcastIdentity(record.track)
  const elapsed = Date.now() - record.podcastSavedAt
  if (
    !identity ||
    (!force && elapsed >= 0 && elapsed < PODCAST_PROGRESS_INTERVAL_MS)
  )
    return
  record.podcastSavedAt = Date.now()
  const podcasts = usePodcastStore.getState()
  if (
    podcasts.getEpisodeProgress(identity.feedUrl, identity.guid) !==
    positionMs / 1000
  ) {
    podcasts.setEpisodeProgress(
      identity.feedUrl,
      identity.guid,
      positionMs / 1000
    )
  }
  if (completed) podcasts.markEpisodeCompleted(identity.feedUrl, identity.guid)
}
export function podcastResumePosition(track: MusicTrack): number {
  const identity = podcastIdentity(track)
  if (!identity) return 0
  const podcasts = usePodcastStore.getState()
  if (podcasts.isEpisodeCompleted(identity.feedUrl, identity.guid)) return 0
  const position =
    podcasts.getEpisodeProgress(identity.feedUrl, identity.guid) * 1000
  return Number.isFinite(position) &&
    position > 0 &&
    (track.duration <= 0 || position < track.duration)
    ? position
    : 0
}
