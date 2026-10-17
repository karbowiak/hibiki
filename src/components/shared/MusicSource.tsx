import type { MusicTrack } from "../../types/music"
import { hasIndependentAudio, isYoutubeMusicId } from "../../backends/ytmusic/tracks"

export type MusicSource = "plex" | "ytmusic"

export function trackMusicSource(track: MusicTrack, libraryName?: string): MusicSource | null {
  if (isYoutubeMusicId(track.id)) return "ytmusic"
  if (track.mediaInfo?.localAudio || hasIndependentAudio(track)) return null
  return libraryName === "Plex" ? "plex" : null
}

export function YoutubeMusicLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#ff0033" />
      <circle cx="12" cy="12" r="7.1" fill="none" stroke="#fff" strokeWidth=".9" />
      <path d="M9.7 8.5v7l6.1-3.5z" fill="#fff" />
    </svg>
  )
}

export function PlexLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 0h7.5L20 12l-7.5 12H5l7.5-12z" fill="#e5a00d" />
    </svg>
  )
}

export function MusicSourceBadge({ source, label = false, className = "" }: {
  source: MusicSource | null
  label?: boolean
  className?: string
}) {
  if (!source) return null
  const name = source === "ytmusic" ? "YouTube Music" : "Plex"
  return (
    <span data-music-source={source} title={name} className={`inline-flex shrink-0 items-center gap-1.5 ${className}`}>
      {source === "ytmusic" ? <YoutubeMusicLogo size={14} /> : <PlexLogo size={14} />}
      <span className={label ? undefined : "sr-only"}>{source === "ytmusic" ? "YTM" : "Plex"}</span>
    </span>
  )
}
