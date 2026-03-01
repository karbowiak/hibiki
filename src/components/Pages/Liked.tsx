import { useEffect } from "react"
import { Link } from "wouter"
import { useLibraryStore, usePlayerStore, useConnectionStore, buildPlexImageUrl, useUIStore } from "../../stores"
import { prefetchTrackAudio } from "../../stores/playerStore"

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`
}

function formatTotalMs(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  const hr = Math.floor(totalMin / 60)
  const min = totalMin % 60
  if (hr === 0) return `${min} min`
  return min > 0 ? `${hr} hr ${min} min` : `${hr} hr`
}

function formatDate(value: string | null): string {
  if (!value) return ""
  const num = Number(value)
  const date = isNaN(num) ? new Date(value) : new Date(num * 1000)
  if (isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date)
}

function keyToId(key: string): number {
  return parseInt(key.split("/").pop() ?? "0", 10)
}

export function Liked() {
  const { likedTracks, fetchLikedTracks } = useLibraryStore()
  const { playTrack } = usePlayerStore()
  const { baseUrl, token, musicSectionId } = useConnectionStore()
  const { pageRefreshKey } = useUIStore()

  useEffect(() => {
    if (musicSectionId !== null) void fetchLikedTracks(musicSectionId)
  }, [musicSectionId, pageRefreshKey])

  const seen = new Set<string>()
  const tracks = likedTracks.filter(t => {
    const key = t.guid ?? `${t.grandparent_key}||${t.title}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const totalMs = tracks.reduce((sum, t) => sum + t.duration, 0)
  const count = tracks.length

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="flex flex-row items-end p-8">
        <div className="flex w-60 h-60 flex-shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-indigo-700 to-blue-400 shadow-2xl">
          <svg viewBox="0 0 24 24" width="80" height="80" fill="white">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        </div>

        {/* Info column — same height as art */}
        <div className="pl-6 flex flex-col justify-between flex-1 h-60 min-w-0">
          <div>
            <div className="whitespace-nowrap text-[76px] font-black leading-none">
              Liked
            </div>
            <p className="mt-2 max-w-xl select-text text-sm text-gray-400">
              All your rated tracks, in one convenient place.
            </p>
          </div>

          {/* Bottom row: stats left, buttons right */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">
              {count} {count === 1 ? "song" : "songs"}
              {totalMs > 0 && <> · {formatTotalMs(totalMs)}</>}
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => { if (count === 0) return; const s = [...tracks].sort(() => Math.random() - 0.5); void playTrack(s[0], s) }}
                disabled={count === 0}
                title="Shuffle"
                className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <svg role="img" height="18" width="18" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
                  <path d="m7.5 10.723.98-1.167.957 1.14a2.25 2.25 0 0 0 1.724.804h1.947l-1.017-1.018a.75.75 0 1 1 1.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 1 1-1.06-1.06L13.109 13H11.16a3.75 3.75 0 0 1-2.873-1.34l-.787-.938z" />
                </svg>
              </button>
              <button
                onClick={() => count > 0 && void playTrack(tracks[0], tracks)}
                disabled={count === 0}
                title="Play"
                className="flex h-14 w-14 items-center justify-center rounded-full bg-[#1db954] text-black shadow-lg hover:bg-[#1ed760] hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor">
                  <polygon points="3,2 13,8 3,14" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Track list */}
      <div className="px-8 pt-4">
        <table className="w-full text-sm text-gray-400">
          <thead className="border-b border-white/10">
            <tr>
              <th className="p-2 text-center w-8">#</th>
              <th className="p-2 text-left">Title</th>
              <th className="p-2 text-left">Album</th>
              <th className="p-2 text-left">Date Rated</th>
              <th className="p-2 text-right">Duration</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((track, idx) => {
              const trackThumb = track.thumb
                ? buildPlexImageUrl(baseUrl, token, track.thumb)
                : null
              const albumId = keyToId(track.parent_key)
              const artistId = keyToId(track.grandparent_key)
              return (
                <tr
                  key={track.rating_key}
                  className="group cursor-pointer hover:bg-white/5 rounded"
                  onClick={() => void playTrack(track, tracks)}
                  onMouseEnter={() => prefetchTrackAudio(track)}
                >
                  <td className="p-2 text-center w-8">
                    <span className="group-hover:hidden">{idx + 1}</span>
                    <span className="hidden group-hover:flex items-center justify-center">
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                        <polygon points="3,2 13,8 3,14" />
                      </svg>
                    </span>
                  </td>
                  <td className="p-2">
                    <div className="flex items-center gap-3">
                      {trackThumb ? (
                        <img className="h-10 w-10 rounded-sm flex-shrink-0 object-cover" src={trackThumb} alt="" />
                      ) : (
                        <div className="h-10 w-10 rounded-sm flex-shrink-0 bg-[#282828]" />
                      )}
                      <div className="min-w-0">
                        <div className="text-white truncate">{track.title}</div>
                        <div className="truncate">
                          {artistId ? (
                            <Link
                              href={`/artist/${artistId}`}
                              className="text-gray-500 hover:text-white hover:underline transition-colors"
                              onClick={e => e.stopPropagation()}
                            >
                              {track.grandparent_title}
                            </Link>
                          ) : (
                            <span className="text-gray-500">{track.grandparent_title}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="p-2 truncate max-w-[200px]">
                    {albumId ? (
                      <Link
                        href={`/album/${albumId}`}
                        className="hover:text-white hover:underline transition-colors"
                        onClick={e => e.stopPropagation()}
                      >
                        {track.parent_title}
                      </Link>
                    ) : (
                      track.parent_title
                    )}
                  </td>
                  <td className="p-2">{formatDate(track.last_rated_at ?? null)}</td>
                  <td className="p-2 text-right tabular-nums">{formatMs(track.duration)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {count === 0 && (
          <div className="py-12 text-center text-sm text-gray-500">
            No rated tracks yet. Rate a song in Plex to see it here.
          </div>
        )}
      </div>
    </div>
  )
}
