import { useEffect, useState, useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import { usePodcastStore } from "../../backends/podcast/store"
import { usePlayerStore } from "../../stores/playerStore"
import { episodeProgressKey, episodesToTracks } from "../../backends/podcast/mappers"
import { EpisodeRow } from "../EpisodeRow"
import { ArtworkImage } from "../shared/ArtworkImage"
import { podcastFeedPath } from "../../lib/podcastRoute"
import { buildExternalImageUrl } from "../../lib/imageUrl"
import { UltraBlur } from "../UltraBlur"
import type { PodcastDetail, PodcastEpisode } from "../../backends/podcast/api"

export function PodcastDetailPage({ feedUrl }: { feedUrl: string }) {
  const { getFeed, subscribe, unsubscribe, isSubscribed, getEpisodeProgress, isEpisodeCompleted } =
    usePodcastStore(useShallow(s => ({
      subscriptions: s.subscriptions,
      listenProgress: s.listenProgress,
      completedEpisodes: s.completedEpisodes,
      getFeed: s.getFeed,
      subscribe: s.subscribe,
      unsubscribe: s.unsubscribe,
      isSubscribed: s.isSubscribed,
      getEpisodeProgress: s.getEpisodeProgress,
      isEpisodeCompleted: s.isEpisodeCompleted,
    })))

  const { playTrack, currentTrack, isPlaying, pause, resume } = usePlayerStore(useShallow(s => ({
    playTrack: s.playTrack,
    currentTrack: s.currentTrack,
    isPlaying: s.isPlaying,
    pause: s.pause,
    resume: s.resume,
  })))

  const [result, setResult] = useState<{ feedUrl: string; podcast: PodcastDetail | null; loading: boolean }>({ feedUrl, podcast: null, loading: true })
  const [retry, setRetry] = useState(0)
  const podcast = result.feedUrl === feedUrl ? result.podcast : null
  const isLoading = result.feedUrl !== feedUrl || result.loading
  const [descExpanded, setDescExpanded] = useState(false)
  const subscribed = isSubscribed(feedUrl)

  useEffect(() => {
    let current = true
    setResult({ feedUrl, podcast: null, loading: true })
    setDescExpanded(false)
    void getFeed(feedUrl).then(detail => {
      if (current) setResult({ feedUrl, podcast: detail, loading: false })
    }).catch(() => {
      if (current) setResult({ feedUrl, podcast: null, loading: false })
    })
    return () => { current = false }
  }, [feedUrl, getFeed, retry])

  // Map episodes to MusicTrack for playback
  const episodeTracks = useMemo(() => {
    if (!podcast) return []
    return episodesToTracks(
      podcast.episodes,
      feedUrl,
      podcast.title,
      podcast.author,
      podcast.artwork_url,
    )
  }, [podcast, feedUrl])

  const handlePlayEpisode = (ep: PodcastEpisode, index: number) => {
    const track = episodeTracks[index]
    if (!track) return
    if (currentTrack?.id === track.id) {
      if (isPlaying) pause(); else resume()
      return
    }
    void playTrack(track, episodeTracks, podcast?.title ?? "Podcast", podcastFeedPath(feedUrl))
  }

  const handlePlayAll = () => {
    if (episodeTracks.length === 0) return
    void playTrack(episodeTracks[0], episodeTracks, podcast?.title ?? "Podcast", podcastFeedPath(feedUrl))
  }

  const handleSubscribe = () => {
    if (!podcast) return
    if (subscribed) {
      unsubscribe(feedUrl)
    } else {
      subscribe({
        feedUrl,
        title: podcast.title,
        author: podcast.author,
        artworkUrl: podcast.artwork_url,
      })
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-accent" />
      </div>
    )
  }

  if (!podcast) {
    return (
      <div className="flex h-full items-center justify-center gap-3" role="alert">
        <p className="text-gray-400">Failed to load podcast feed.</p>
        <button onClick={() => setRetry(value => value + 1)}>Retry</button>
      </div>
    )
  }

  const artwork = buildExternalImageUrl(podcast.artwork_url)
  const playableEpisodes = podcast.episodes.filter(ep => ep.audio_url)

  return (
    <div>
      {/* Hero section */}
      <div className="relative overflow-hidden">
        <UltraBlur src={artwork} />
        <div className="relative z-10 flex gap-8 p-8 pb-6">
          {/* Artwork */}
          <div className="h-56 w-56 flex-shrink-0 overflow-hidden rounded-xl bg-white/5 shadow-2xl">
            {artwork ? (
              <ArtworkImage loading="eager" src={artwork} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-gray-500">
                <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM6 10a1 1 0 1 0-2 0 8 8 0 0 0 7 7.93V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-3.07A8 8 0 0 0 20 10a1 1 0 1 0-2 0 6 6 0 0 1-12 0z" />
                </svg>
              </div>
            )}
          </div>

          {/* Info */}
          <div className="flex min-w-0 flex-1 flex-col justify-end">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-300">Podcast</p>
            <h1 className="mb-2 text-4xl font-bold leading-tight">{podcast.title}</h1>
            <p className="mb-3 text-sm text-gray-300">{podcast.author}</p>
            {podcast.description && (
              <div className="mb-4">
                <p className={`text-sm text-gray-400 ${descExpanded ? "" : "line-clamp-2"}`}>
                  {podcast.description}
                </p>
                {podcast.description.length > 120 && (
                  <button
                    onClick={() => setDescExpanded(!descExpanded)}
                    className="mt-1 text-xs font-medium text-white/60 hover:text-white/90"
                  >
                    {descExpanded ? "Show less" : "Show more"}
                  </button>
                )}
              </div>
            )}

            {/* Category tags */}
            {podcast.categories.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {podcast.categories.map(cat => (
                  <span key={cat} className="rounded-full border border-white/20 px-2.5 py-0.5 text-xs text-gray-300">
                    {cat}
                  </span>
                ))}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-3">
              <button
                onClick={handlePlayAll}
                disabled={playableEpisodes.length === 0}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-black shadow-lg transition-all hover:scale-105 hover:brightness-110 active:scale-95 disabled:opacity-40"
              >
                <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor">
                  <polygon points="3,2 13,8 3,14" />
                </svg>
              </button>
              <button
                onClick={handleSubscribe}
                className={`rounded-full border px-5 py-1.5 text-sm font-semibold transition-colors ${
                  subscribed
                    ? "border-accent/50 text-accent hover:border-accent"
                    : "border-white/30 text-white hover:border-white/60"
                }`}
              >
                {subscribed ? "Subscribed" : "Subscribe"}
              </button>
            </div>

            <p className="mt-3 text-xs text-gray-500">
              {playableEpisodes.length} episode{playableEpisodes.length !== 1 ? "s" : ""}
              {podcast.language && ` · ${podcast.language.toUpperCase()}`}
            </p>
          </div>
        </div>
      </div>

      {/* Episode list */}
      <div className="px-4 pb-8">
        <h2 className="mb-2 px-4 pt-4 text-lg font-bold">Episodes</h2>
        <div className="divide-y divide-white/5">
          {playableEpisodes.map((ep, i) => {
            const trackId = episodeTracks[i]?.id
            const episodePlaying = trackId != null && currentTrack?.id === trackId && isPlaying
            const progressSecs = getEpisodeProgress(feedUrl, episodeProgressKey(ep))
            const progress = ep.duration_secs > 0 ? progressSecs / ep.duration_secs : 0
            const completed = isEpisodeCompleted(feedUrl, episodeProgressKey(ep))

            return (
              <EpisodeRow
                key={trackId ?? i}
                episode={ep}
                podcastArtworkUrl={podcast.artwork_url}
                isPlaying={episodePlaying}
                progress={progress}
                isCompleted={completed}
                onPlay={() => handlePlayEpisode(ep, i)}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
