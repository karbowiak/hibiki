import type { MusicTrack } from "../../types/music"
import type { YoutubeMusicSong } from "./api"
import { buildExternalImageUrl } from "../../lib/imageUrl"

export function isYoutubeMusicId(id: string): boolean {
  return /^ytmusic:[A-Za-z0-9_-]{11}$/.test(id)
}

export function isYoutubeMusicTrack(track: MusicTrack): boolean {
  return isYoutubeMusicId(track.streamUrl ?? "")
}

/** Public URLs and opaque native sources bypass the active library provider. */
export function hasIndependentAudio(track: MusicTrack): boolean {
  return (
    /^https?:\/\//i.test(track.streamUrl ?? "") || isYoutubeMusicTrack(track)
  )
}

export function youtubeMusicTrack(song: YoutubeMusicSong): MusicTrack {
  if (!/^[A-Za-z0-9_-]{11}$/.test(song.videoId))
    throw Error("Choose a valid YouTube Music song.")
  const parts = song.duration?.split(":").map(Number) ?? []
  const duration =
    parts.length >= 2 &&
    parts.length <= 3 &&
    parts.every(
      (part, index) =>
        Number.isInteger(part) && part >= 0 && (index === 0 || part < 60)
    )
      ? parts.reduce((seconds, part) => seconds * 60 + part, 0) * 1000
      : 0
  const id = `ytmusic:${song.videoId}`
  // Use the shared native disk cache. Older saved queues have no artwork URL;
  // the public video thumbnail recovers their cover without another API lookup.
  const thumbnail = buildExternalImageUrl(
    song.thumbnail || `https://i.ytimg.com/vi/${song.videoId}/hqdefault.jpg`
  )
  return {
    id,
    streamUrl: id,
    providerKey: "ytmusic",
    title: song.title,
    artistName: song.artist,
    albumName: song.album ?? "",
    duration,
    trackNumber: 0,
    albumId: null,
    albumYear: null,
    artistId: null,
    year: 0,
    playCount: 0,
    thumbUrl: thumbnail,
    albumThumbUrl: thumbnail,
    artistThumbUrl: null,
    summary: null,
    userRating: null,
    addedAt: null,
    lastPlayedAt: null,
    guid: null,
    codec: null,
    bitrate: null,
    channels: null,
    bitDepth: null,
    samplingRate: null,
    gain: null,
    albumGain: null,
    peak: null,
    loudness: null,
  }
}
