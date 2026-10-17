import { ArtworkImage } from "./shared/ArtworkImage"
import { buildExternalImageUrl } from "../lib/imageUrl"
import clsx from "clsx"
import type { PodcastEpisode } from "../backends/podcast/api"

interface EpisodeRowProps {
  episode: PodcastEpisode
  podcastArtworkUrl: string
  isPlaying?: boolean
  progress?: number // 0-1
  isCompleted?: boolean
  onPlay: () => void
}

function formatDuration(secs: number): string {
  if (secs <= 0) return ""
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m} min`
}

function formatDate(dateStr: string): string {
  if (!dateStr) return ""
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
  } catch {
    return dateStr
  }
}

export function EpisodeRow({ episode, podcastArtworkUrl, isPlaying, progress, isCompleted, onPlay }: EpisodeRowProps) {
  const thumb = buildExternalImageUrl(episode.artwork_url || podcastArtworkUrl)
  const duration = formatDuration(episode.duration_secs)
  const date = formatDate(episode.pub_date)

  return (
    <div className={clsx(
      "group flex items-center gap-4 rounded-lg px-4 py-3 transition-colors hover:bg-white/5",
      isPlaying && "bg-white/5"
    )}>
      {/* Artwork + play button */}
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-white/5">
        {thumb && <ArtworkImage src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />}
        <button
          onClick={onPlay}
          aria-label={`${isPlaying ? "Pause" : "Play"} ${episode.title}`}
          className={clsx(
            "absolute inset-0 flex items-center justify-center transition-opacity",
            isPlaying ? "bg-black/40 opacity-100" : "bg-black/40 opacity-0 group-hover:opacity-100"
          )}
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="18" height="18" fill="white">
              <polygon points="3,2 13,8 3,14" />
            </svg>
          )}
        </button>
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={clsx(
            "truncate text-sm font-medium",
            isPlaying ? "text-accent" : "text-(--text-primary)"
          )}>
            {episode.title}
          </span>
          {isCompleted && (
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" className="shrink-0 text-accent">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z" />
            </svg>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>{date}</span>
          {duration && <><span className="text-gray-600">·</span><span>{duration}</span></>}
          {episode.episode_number != null && (
            <><span className="text-gray-600">·</span><span>Ep. {episode.episode_number}</span></>
          )}
        </div>
        {/* Progress bar */}
        {progress != null && progress > 0 && progress < 1 && (
          <div className="mt-1.5 h-1 w-full max-w-[200px] overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  )
}
