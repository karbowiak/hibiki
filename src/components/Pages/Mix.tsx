import { useEffect, useMemo, useState } from "react"
import { Link } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { useConnectionStore, useLibraryStore, usePlayerStore, buildPlexImageUrl } from "../../stores"
import { getMixTracks, searchLibrary, buildItemUri } from "../../lib/plex"
import { UltraBlur } from "../UltraBlur"
import type { Track, Playlist } from "../../types/plex"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function keyToId(key: string): number {
  return parseInt(key.split("/").pop() ?? "0", 10)
}

function mixTitleToArtistName(title: string): string {
  return title.replace(/\s+(Mix|Radio|Station|Mix Radio)$/i, "").trim()
}

function shuffleTracks(arr: Track[]): Track[] {
  return [...arr].sort(() => Math.random() - 0.5)
}

const mixThumbCache = new Map<string, string>()

// ---------------------------------------------------------------------------
// Module-level state: the mix item selected on the homepage.
// Plex hub mixes have rating_key=0 — we cannot route by ID, so Home.tsx
// calls selectMix() before navigating to /mix.
// ---------------------------------------------------------------------------

let _selectedMix: (Playlist & { type: "playlist" }) | null = null

export function selectMix(item: Playlist & { type: "playlist" }) {
  _selectedMix = item
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MixPage() {
  const [mixItem] = useState<(Playlist & { type: "playlist" }) | null>(() => _selectedMix)

  const { musicSectionId, sectionUuid, baseUrl, token } = useConnectionStore(
    useShallow(s => ({
      musicSectionId: s.musicSectionId,
      sectionUuid: s.sectionUuid,
      baseUrl: s.baseUrl,
      token: s.token,
    }))
  )

  const { playTrack, playFromUri, addToQueue, currentTrack } = usePlayerStore(
    useShallow(s => ({
      playTrack: s.playTrack,
      playFromUri: s.playFromUri,
      addToQueue: s.addToQueue,
      currentTrack: s.currentTrack,
    }))
  )

  const [tracks, setTracks] = useState<Track[]>(() => {
    if (!mixItem?.key) return []
    // Shuffle on mount so the displayed list is randomised immediately.
    return shuffleTracks(useLibraryStore.getState().mixTracksCache[mixItem.key] ?? [])
  })
  const [isLoading, setIsLoading] = useState(() => {
    if (!mixItem?.key) return false
    const cached = useLibraryStore.getState().mixTracksCache[mixItem.key]
    return !cached || cached.length === 0
  })
  const [artistThumb, setArtistThumb] = useState<string | null>(
    () => mixItem ? (mixThumbCache.get(mixItem.title) ?? null) : null
  )

  // Unique artists derived from the loaded track list, preserving first-seen order.
  const artists = useMemo(() => {
    const seen = new Set<string>()
    const result: { title: string; id: number }[] = []
    for (const t of tracks) {
      if (t.grandparent_title && !seen.has(t.grandparent_title)) {
        seen.add(t.grandparent_title)
        result.push({ title: t.grandparent_title, id: keyToId(t.grandparent_key) })
      }
    }
    return result
  }, [tracks])

  // Fetch the track list for this mix (skipped if already pre-cached).
  // Cache hits are already shuffled and set via the useState initializer above.
  useEffect(() => {
    if (!mixItem?.key) return
    const cached = useLibraryStore.getState().mixTracksCache[mixItem.key]
    if (cached && cached.length > 0) {
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    getMixTracks(mixItem.key)
      .then(t => setTracks(shuffleTracks(t)))
      .catch(() => setTracks([]))
      .finally(() => setIsLoading(false))
  }, [mixItem?.key])

  // Look up the artist thumbnail (e.g. "Ado Mix" → search for "Ado").
  useEffect(() => {
    if (!mixItem || !musicSectionId) return
    const cached = mixThumbCache.get(mixItem.title)
    if (cached) { setArtistThumb(cached); return }
    const artistName = mixTitleToArtistName(mixItem.title)
    if (!artistName) return
    searchLibrary(musicSectionId, artistName, "artist")
      .then(results => {
        const artist =
          results.find(r => r.type === "artist" && r.title.toLowerCase() === artistName.toLowerCase()) ??
          results.find(r => r.type === "artist")
        if (artist && artist.type === "artist" && artist.thumb) {
          const url = buildPlexImageUrl(baseUrl, token, artist.thumb)
          mixThumbCache.set(mixItem.title, url)
          setArtistThumb(url)
        }
      })
      .catch(() => {})
  }, [mixItem?.title, musicSectionId])

  if (!mixItem) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <h1 className="mb-2 text-xl font-bold">No mix selected</h1>
        <p className="text-sm text-white/50">Navigate to a mix from the home page.</p>
      </div>
    )
  }

  const artPath = mixItem.thumb ?? mixItem.composite
  const thumbUrl = artPath ? buildPlexImageUrl(baseUrl, token, artPath) : null
  const displayThumb = artistThumb ?? thumbUrl
  const totalMs = tracks.reduce((sum, t) => sum + t.duration, 0)

  function handlePlayInOrder() {
    if (tracks.length === 0) return
    void playTrack(tracks[0], tracks, mixItem!.title, "/mix")
  }

  function handlePlayShuffled() {
    if (tracks.length === 0) return
    const shuffled = [...tracks].sort(() => Math.random() - 0.5)
    void playTrack(shuffled[0], shuffled, mixItem!.title, "/mix")
  }

  function handlePlayRadio() {
    if (!sectionUuid || !mixItem.key) return
    void playFromUri(buildItemUri(sectionUuid, mixItem.key))
  }

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="relative flex flex-row items-end p-8 overflow-hidden rounded-t-lg hero-overlay">
        <UltraBlur src={displayThumb} />
        <div className="relative z-10 flex flex-row items-end w-full gap-0">
          {/* Cover art */}
          {displayThumb ? (
            <img src={displayThumb} alt="" className="w-60 h-60 rounded-md shadow-2xl object-cover flex-shrink-0" />
          ) : (
            <div className="w-60 h-60 rounded-md bg-app-surface shadow-2xl flex-shrink-0 flex items-center justify-center">
              <svg height="64" width="64" viewBox="0 0 24 24" fill="currentColor" className="text-white/20">
                <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zm-2 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
              </svg>
            </div>
          )}

          {/* Info */}
          <div className="pl-6 flex flex-col justify-between flex-1 h-60 min-w-0">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-widest text-white/50 mb-1">Mix for You</p>
              <div className="text-[76px] font-black leading-none drop-shadow truncate">
                {mixItem.title}
              </div>
              {/* Artist list */}
              {isLoading && artists.length === 0 ? (
                <div className="mt-2 h-4 w-2/3 rounded bg-white/10 animate-pulse" />
              ) : artists.length > 0 ? (
                <p className="mt-2 text-sm text-white/60 truncate">
                  {artists.map((a, i) => (
                    <span key={a.title}>
                      {i > 0 && <span className="mx-1.5 text-white/30">·</span>}
                      {a.id ? (
                        <Link
                          href={`/artist/${a.id}`}
                          className="hover:text-white hover:underline transition-colors"
                          onClick={e => e.stopPropagation()}
                        >
                          {a.title}
                        </Link>
                      ) : a.title}
                    </span>
                  ))}
                </p>
              ) : null}
            </div>

            {/* Stats + controls */}
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-400">
                {isLoading
                  ? "Loading…"
                  : `${tracks.length} ${tracks.length === 1 ? "song" : "songs"}${totalMs > 0 ? ` · ${formatTotalMs(totalMs)}` : ""}`
                }
              </p>

              <div className="relative z-20 flex items-center gap-3">
                {/* Play in listed order */}
                <button
                  onClick={handlePlayInOrder}
                  disabled={tracks.length === 0}
                  title="Play in order"
                  className="flex h-14 w-14 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-accent hover:bg-black/45 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor">
                    <polygon points="3,2 13,8 3,14" />
                  </svg>
                </button>

                {/* Shuffle the fetched track list */}
                <button
                  onClick={handlePlayShuffled}
                  disabled={tracks.length === 0}
                  title="Shuffle play"
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-accent hover:bg-black/45 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                    <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356A2.25 2.25 0 0 1 11.16 4.5h1.949l-1.018 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5zm9.831 8.17l.979 1.167.28.334A3.75 3.75 0 0 0 14.36 14.5h1.64V13h-1.64a2.25 2.25 0 0 1-1.726-.83l-.28-.335-1.733-2.063-.979 1.167 1.18 1.731z" />
                  </svg>
                </button>

                {/* Continuous radio — server generates an endless stream */}
                <button
                  onClick={handlePlayRadio}
                  disabled={!sectionUuid || !mixItem.key}
                  title="Play as continuous radio"
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-accent hover:bg-black/45 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Track list */}
      <div className="px-8 pt-2">
        <table className="w-full text-sm text-gray-400">
          <thead className="border-b border-white/10">
            <tr>
              <th className="p-2 text-center w-8">#</th>
              <th className="p-2 text-left">Title</th>
              <th className="p-2 text-left">Album</th>
              <th className="p-2 text-right">Duration</th>
            </tr>
          </thead>
          <tbody>
            {/* Skeleton rows while loading */}
            {isLoading && tracks.length === 0 && Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="animate-pulse">
                <td className="p-2 w-8"><div className="h-3 w-3 rounded bg-white/10 mx-auto" /></td>
                <td className="p-2">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-sm bg-white/10 flex-shrink-0" />
                    <div className="space-y-1.5 flex-1">
                      <div className="h-3 rounded bg-white/10 w-2/3" />
                      <div className="h-2.5 rounded bg-white/10 w-1/3" />
                    </div>
                  </div>
                </td>
                <td className="p-2"><div className="h-3 rounded bg-white/10 w-3/4" /></td>
                <td className="p-2 text-right"><div className="h-3 rounded bg-white/10 w-10 ml-auto" /></td>
              </tr>
            ))}

            {tracks.map((track, idx) => {
              const rawThumb = track.thumb || track.parent_thumb || null
              const trackThumb = rawThumb ? buildPlexImageUrl(baseUrl, token, rawThumb) : null
              const albumId = keyToId(track.parent_key)
              const artistId = keyToId(track.grandparent_key)
              const isActive = currentTrack?.rating_key === track.rating_key
              return (
                <tr
                  key={`${track.rating_key}-${idx}`}
                  className={`group cursor-pointer rounded ${isActive ? "bg-white/5" : "hover:bg-white/5"}`}
                  onClick={() => void playTrack(track, tracks, mixItem.title, "/mix")}
                >
                  <td className="p-2 text-center w-8">
                    {isActive ? (
                      <>
                        <span className="group-hover:hidden flex items-center justify-center text-accent">
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                            <rect x="1" y="3" width="3" height="10" rx="1"/>
                            <rect x="6" y="1" width="3" height="12" rx="1"/>
                            <rect x="11" y="5" width="3" height="8" rx="1"/>
                          </svg>
                        </span>
                        <span className="hidden group-hover:flex items-center justify-center text-accent">
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                            <polygon points="3,2 13,8 3,14" />
                          </svg>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="group-hover:hidden">{idx + 1}</span>
                        <span className="hidden group-hover:flex items-center justify-center">
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                            <polygon points="3,2 13,8 3,14" />
                          </svg>
                        </span>
                      </>
                    )}
                  </td>

                  <td className="p-2">
                    <div className="flex items-center gap-3">
                      {trackThumb ? (
                        <img className="h-10 w-10 rounded-sm flex-shrink-0 object-cover" src={trackThumb} alt="" />
                      ) : (
                        <div className="h-10 w-10 rounded-sm flex-shrink-0 bg-app-surface" />
                      )}
                      <div className="min-w-0">
                        <div className={`truncate ${isActive ? "text-accent" : "text-white"}`}>{track.title}</div>
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="truncate shrink min-w-0">
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
                          <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <button
                              className="flex items-center gap-0.5 text-xs text-gray-400 hover:text-white transition-colors px-1 py-0.5 rounded hover:bg-white/10"
                              title="Add to Queue"
                              onClick={e => { e.stopPropagation(); addToQueue([track]) }}
                            >
                              <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor">
                                <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/>
                              </svg>
                              Queue
                            </button>
                          </div>
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

                  <td className="p-2 text-right tabular-nums">{formatMs(track.duration)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {!isLoading && tracks.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-500">
            No tracks found for this mix.
          </div>
        )}
      </div>
    </div>
  )
}
