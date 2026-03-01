import { useEffect, useState } from "react"
import { Link } from "wouter"
import { useConnectionStore, buildPlexImageUrl, usePlayerStore, useUIStore } from "../../stores"
import {
  getArtist,
  getArtistAlbumsInSection,
  getArtistSimilar,
  getArtistPopularTracksInSection,
  getArtistSonicallySimilar,
  getRelatedHubs,
  getArtistStations,
  buildItemUri,
} from "../../lib/plex"
import { useFocalPoint } from "../../lib/focalPoint"
import type { Artist, Album, Track, Hub, Playlist } from "../../types/plex"
import { MediaCard } from "../MediaCard"
import { ScrollRow } from "../ScrollRow"
import { UltraBlur } from "../UltraBlur"
import { getCachedArtist, prefetchAlbum, prefetchArtist, setArtistCache } from "../../stores/metadataCache"

function fmtDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function Stars({ rating }: { rating?: number | null }) {
  const filled = Math.round((rating ?? 0) / 2)
  return (
    <span className="flex gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <svg
          key={i}
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill={i < filled ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.5"
          className={i < filled ? "text-yellow-400" : "text-gray-600"}
        >
          <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
        </svg>
      ))}
    </span>
  )
}

function dedupe<T extends { rating_key: number }>(items: T[]): T[] {
  const seen = new Set<number>()
  return items.filter(item => {
    if (seen.has(item.rating_key)) return false
    seen.add(item.rating_key)
    return true
  })
}

const SKIP_HUB_IDS = new Set([
  "artist.albums",
  "artist.mostpopulartracks",
  "artist.mostplayedtracks",
])

export function ArtistPage({ artistId }: { artistId: number }) {
  const { baseUrl, token, musicSectionId, sectionUuid } = useConnectionStore()
  const { playTrack, playFromUri } = usePlayerStore()
  const { pageRefreshKey } = useUIStore()

  const cached = getCachedArtist(artistId)
  const [artist, setArtist] = useState<Artist | null>(cached?.artist ?? null)
  const [fullAlbums, setFullAlbums] = useState<Album[]>(cached?.albums ?? [])
  const [singles, setSingles] = useState<Album[]>(cached?.singles ?? [])
  const [popularTracks, setPopularTracks] = useState<Track[]>([])
  const [similarArtists, setSimilarArtists] = useState<Artist[]>([])
  const [sonicallySimilar, setSonicallySimilar] = useState<Artist[]>([])
  const [relatedHubs, setRelatedHubs] = useState<Hub[]>([])
  const [stations, setStations] = useState<Playlist[]>([])
  const [isLoading, setIsLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)

  // UI state
  const [bioExpanded, setBioExpanded] = useState(false)
  const [showImageModal, setShowImageModal] = useState(false)
  const [showHeroModal, setShowHeroModal] = useState(false)

  useEffect(() => {
    setError(null)
    setBioExpanded(false)
    setShowHeroModal(false)

    // Seed ALL state from persistent cache — avoids loading flash AND layout shift.
    // useState(initialValue) only runs on mount, so navigating between artists
    // needs this explicit re-seed at the start of every effect run.
    const freshCache = getCachedArtist(artistId)
    if (freshCache) {
      setArtist(freshCache.artist)
      setFullAlbums(freshCache.albums)
      setSingles(freshCache.singles)
      setPopularTracks(freshCache.popularTracks)
      setSimilarArtists(freshCache.similarArtists)
      setSonicallySimilar(freshCache.sonicallySimilar)
      setRelatedHubs(freshCache.relatedHubs)
      setStations(freshCache.stations)
      setIsLoading(false)
    } else {
      // No cache — clear stale data from previous artist, show loading spinner.
      setArtist(null)
      setFullAlbums([])
      setSingles([])
      setPopularTracks([])
      setSimilarArtists([])
      setSonicallySimilar([])
      setRelatedHubs([])
      setStations([])
      setIsLoading(true)
    }

    // Always re-fetch for freshness (silently when cache-seeded).
    const sectionId = musicSectionId ?? 0
    Promise.all([
      getArtist(artistId),
      getArtistAlbumsInSection(sectionId, artistId).catch(() => [] as Album[]),
      getArtistAlbumsInSection(sectionId, artistId, "EP,Single").catch(() => [] as Album[]),
      getArtistPopularTracksInSection(sectionId, artistId, 15).catch(() => [] as Track[]),
      getArtistSimilar(artistId).catch(() => [] as Artist[]),
      getArtistSonicallySimilar(artistId, 20).catch(() => [] as Artist[]),
      getRelatedHubs(artistId, 20).catch(() => [] as Hub[]),
      getArtistStations(artistId).catch(() => [] as Playlist[]),
    ])
      .then(([a, allAlbums, singleList, tracks, sim, sonic, hubs, stationList]) => {
        const dedupedSingles = dedupe(singleList)
        const singleKeys = new Set(dedupedSingles.map(s => s.rating_key))
        const albums = dedupe(allAlbums).filter(a => !singleKeys.has(a.rating_key))
        const popularTracks = dedupe(tracks)

        setArtist(a)
        setFullAlbums(albums)
        setSingles(dedupedSingles)
        setPopularTracks(popularTracks)
        setSimilarArtists(sim)
        setSonicallySimilar(sonic)
        setRelatedHubs(hubs)
        setStations(stationList)

        // Update persistent cache for next visit / restart
        setArtistCache(artistId, {
          artist: a,
          albums,
          singles: dedupedSingles,
          popularTracks,
          similarArtists: sim,
          sonicallySimilar: sonic,
          relatedHubs: hubs,
          stations: stationList,
        })
      })
      .catch(e => setError(String(e)))
      .finally(() => setIsLoading(false))
  }, [artistId, musicSectionId, pageRefreshKey])

  // Compute artUrl before early returns so useFocalPoint can be called unconditionally.
  const artUrl = artist?.art ? buildPlexImageUrl(baseUrl, token, artist.art) : null
  const heroBgPos = useFocalPoint(artUrl)

  if (isLoading) return <div className="p-8 text-sm text-gray-400">Loading artist…</div>
  if (error) return <div className="p-8 text-sm text-red-400">{error}</div>
  if (!artist) return null

  const thumbUrl = artist.thumb ? buildPlexImageUrl(baseUrl, token, artist.thumb) : null

  const albumHubs = relatedHubs.filter(h =>
    !SKIP_HUB_IDS.has(h.hub_identifier) &&
    h.metadata.some(m => m.type === "album")
  )
  const hubAlbumKeys = new Set(
    albumHubs.flatMap(h => h.metadata.filter(m => m.type === "album").map(m => m.rating_key))
  )
  const displayAlbums = fullAlbums.filter(a => !hubAlbumKeys.has(a.rating_key))
  const displaySingles = singles.filter(a => !hubAlbumKeys.has(a.rating_key))

  const genres: string[] = []
  const seenGenres = new Set<string>()
  for (const album of [...fullAlbums, ...singles]) {
    for (const g of album.genre) {
      if (!seenGenres.has(g.tag)) { seenGenres.add(g.tag); genres.push(g.tag) }
    }
  }

  const artistUri = sectionUuid
    ? buildItemUri(sectionUuid, `/library/metadata/${artistId}`)
    : null
  const firstStation = stations[0] ?? null
  const radioUri = firstStation && sectionUuid
    ? buildItemUri(sectionUuid, `/library/metadata/${firstStation.rating_key}`)
    : null

  return (
    <div>
      {/* ── Hero ── */}
      <div
        className="relative flex items-end bg-cover p-8 transition-[min-height] duration-500 ease-in-out min-h-80"
        style={artUrl ? { backgroundImage: `url(${artUrl})`, backgroundPosition: heroBgPos } : undefined}
      >
        {/* UltraBlur fallback when there's no wide banner art */}
        {!artUrl && <UltraBlur src={thumbUrl} />}

        <div className="absolute inset-0 bg-gradient-to-t from-[#121212] via-black/55 to-black/20" />

        {/* Expand hero image — top-right, only when a banner image exists */}
        {artUrl && (
          <button
            onClick={() => setShowHeroModal(true)}
            title="View full image"
            className="absolute top-4 right-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white/70 hover:bg-black/60 hover:text-white transition-all"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M1.5 1h4a.5.5 0 0 1 0 1H2.707L6.354 5.646a.5.5 0 1 1-.708.708L2 2.707V5.5a.5.5 0 0 1-1 0v-4A.5.5 0 0 1 1.5 1zm13 0a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V2.707l-3.646 3.647a.5.5 0 1 1-.708-.708L13.293 2H10.5a.5.5 0 0 1 0-1zM1 10.5a.5.5 0 0 1 1 0v2.793l3.646-3.647a.5.5 0 1 1 .708.708L2.707 14H5.5a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5zm15 0a.5.5 0 0 1-.5.5h-4a.5.5 0 0 1 0-1h2.793l-3.647-3.646a.5.5 0 1 1 .708-.708L14 13.293V10.5a.5.5 0 0 1 1 0z" />
            </svg>
          </button>
        )}

        {/* Action buttons — absolutely positioned bottom-right, non-blocking */}
        <div className="absolute bottom-8 right-8 z-10 flex items-center gap-3">
          <button
            onClick={() => artistUri && void playFromUri(artistUri, true)}
            disabled={!artistUri}
            title="Shuffle play"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor">
              <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356A2.25 2.25 0 0 1 11.16 4.5h1.949l-1.018 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5zm9.831 8.17l.979 1.167.28.334A3.75 3.75 0 0 0 14.36 14.5h1.64V13h-1.64a2.25 2.25 0 0 1-1.726-.83l-.28-.335-1.733-2.063-.979 1.167 1.18 1.731z" />
            </svg>
          </button>
          <button
            onClick={() => artistUri && void playFromUri(artistUri, false)}
            disabled={!artistUri}
            title="Play"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-[#1db954] text-black shadow-lg hover:bg-[#1ed760] hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor">
              <polygon points="3,2 13,8 3,14" />
            </svg>
          </button>
          {radioUri && (
            <button
              onClick={() => void playFromUri(radioUri, false)}
              title="Artist radio"
              className="flex h-10 items-center gap-2 rounded-full border border-white/20 px-4 text-sm font-medium text-white hover:border-white/40 hover:bg-white/10 active:scale-95 transition-all"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
              </svg>
              Radio
            </button>
          )}
        </div>

        {/* Main content row */}
        <div className="relative z-10 flex w-full items-end gap-6">
          {/* Avatar — click to open modal */}
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt={artist.title}
              onClick={() => setShowImageModal(true)}
              className="h-36 w-36 flex-shrink-0 cursor-pointer rounded-full object-cover shadow-2xl ring-2 ring-transparent hover:ring-white/40 transition-all"
            />
          ) : (
            <div className="h-36 w-36 flex-shrink-0 rounded-full bg-[#282828] shadow-2xl" />
          )}

          {/* Info column — no fixed height, flows naturally */}
          <div className="flex min-w-0 flex-1 flex-col gap-2 pr-48">
            <div className="text-xs font-semibold uppercase tracking-widest text-gray-300">Artist</div>
            <h1 className="text-5xl font-black leading-none text-white">{artist.title}</h1>

            {genres.slice(0, 5).length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {genres.slice(0, 5).map(g => (
                  <span key={g} className="rounded-full bg-white/10 px-3 py-0.5 text-xs text-gray-300">
                    {g}
                  </span>
                ))}
              </div>
            )}

            {/* Expandable bio */}
            {artist.summary && (
              <div
                className="cursor-pointer select-none"
                onClick={() => setBioExpanded(v => !v)}
                title={bioExpanded ? "Collapse" : "Expand"}
              >
                <div
                  className="overflow-hidden transition-all duration-500 ease-in-out"
                  style={{ maxHeight: bioExpanded ? "500px" : "2.8rem" }}
                >
                  <p className="text-sm leading-relaxed text-gray-300">{artist.summary}</p>
                </div>
                <span className="mt-1 flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors">
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    fill="currentColor"
                    className={`transition-transform duration-300 ${bioExpanded ? "rotate-180" : ""}`}
                  >
                    <path d="M8 10.94L1.53 4.47l1.06-1.06L8 8.82l5.41-5.41 1.06 1.06z" />
                  </svg>
                  {bioExpanded ? "Less" : "More"}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-10 p-8">
        {/* ── Popular Tracks ── */}
        {popularTracks.length > 0 && (
          <section>
            <h2 className="mb-4 text-2xl font-bold">Popular Tracks</h2>
            <div className="flex flex-col">
              {popularTracks.map((track, i) => {
                const albumId = track.parent_key ? track.parent_key.split("/").pop() : null
                return (
                  <div
                    key={track.rating_key}
                    onClick={() => playTrack(track, popularTracks)}
                    className="group flex cursor-pointer items-center gap-3 rounded-md px-3 py-1.5 hover:bg-white/10"
                  >
                    <span className="w-5 flex-shrink-0 text-right text-sm text-gray-400 group-hover:hidden">
                      {i + 1}
                    </span>
                    <span className="hidden w-5 flex-shrink-0 group-hover:flex items-center justify-center">
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                        <polygon points="3,2 13,8 3,14" />
                      </svg>
                    </span>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="min-w-0 truncate text-sm font-medium text-white">
                        {track.title}
                      </span>
                      {albumId && (
                        <span className="flex flex-shrink-0 items-center gap-1.5">
                          <span className="text-xs text-gray-600">·</span>
                          <Link
                            href={`/album/${albumId}`}
                            className="whitespace-nowrap text-xs text-gray-500 hover:text-white hover:underline transition-colors"
                            onClick={e => e.stopPropagation()}
                          >
                            {track.parent_title}
                          </Link>
                        </span>
                      )}
                    </div>
                    <Stars rating={track.user_rating} />
                    <span className="w-12 flex-shrink-0 text-right text-xs tabular-nums text-gray-400">
                      {fmtDuration(track.duration)}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {displayAlbums.length > 0 && (
          <ScrollRow title="Albums" restoreKey={`artist-${artistId}-albums`}>
            {displayAlbums.map(album => (
              <MediaCard
                key={album.rating_key}
                title={album.title}
                desc={String(album.year)}
                thumb={album.thumb ? buildPlexImageUrl(baseUrl, token, album.thumb) : null}
                href={`/album/${album.rating_key}`}
                prefetch={() => prefetchAlbum(album.rating_key)}
                scrollItem
              />
            ))}
          </ScrollRow>
        )}

        {displaySingles.length > 0 && (
          <ScrollRow title="Singles & EPs" restoreKey={`artist-${artistId}-singles`}>
            {displaySingles.map(album => (
              <MediaCard
                key={album.rating_key}
                title={album.title}
                desc={`Single · ${album.year}`}
                thumb={album.thumb ? buildPlexImageUrl(baseUrl, token, album.thumb) : null}
                href={`/album/${album.rating_key}`}
                prefetch={() => prefetchAlbum(album.rating_key)}
                scrollItem
              />
            ))}
          </ScrollRow>
        )}

        {albumHubs.map(hub => {
          const albums = hub.metadata.filter(
            (m): m is Album & { type: "album" } => m.type === "album"
          )
          if (albums.length === 0) return null
          return (
            <ScrollRow
              key={hub.hub_identifier}
              title={hub.title}
              restoreKey={`artist-${artistId}-${hub.hub_identifier}`}
            >
              {albums.map(a => (
                <MediaCard
                  key={a.rating_key}
                  title={a.title}
                  desc={String(a.year)}
                  thumb={a.thumb ? buildPlexImageUrl(baseUrl, token, a.thumb) : null}
                  href={`/album/${a.rating_key}`}
                  prefetch={() => prefetchAlbum(a.rating_key)}
                  scrollItem
                />
              ))}
            </ScrollRow>
          )
        })}

        {similarArtists.length > 0 && (
          <ScrollRow title="Similar Artists" restoreKey={`artist-${artistId}-similar`}>
            {similarArtists.map(a => (
              <MediaCard
                key={a.rating_key}
                title={a.title}
                desc="Artist"
                thumb={a.thumb ? buildPlexImageUrl(baseUrl, token, a.thumb) : null}
                href={`/artist/${a.rating_key}`}
                prefetch={() => prefetchArtist(a.rating_key, musicSectionId ?? 0)}
                isArtist
                scrollItem
              />
            ))}
          </ScrollRow>
        )}

        {sonicallySimilar.length > 0 && (
          <ScrollRow title="Sonically Similar Artists" restoreKey={`artist-${artistId}-sonic`}>
            {sonicallySimilar.map(a => {
              const matchPct = a.distance != null ? `${Math.round((1 - a.distance) * 100)}% match` : "Artist"
              return (
                <MediaCard
                  key={a.rating_key}
                  title={a.title}
                  desc={matchPct}
                  thumb={a.thumb ? buildPlexImageUrl(baseUrl, token, a.thumb) : null}
                  href={`/artist/${a.rating_key}`}
                  prefetch={() => prefetchArtist(a.rating_key, musicSectionId ?? 0)}
                  isArtist
                  scrollItem
                />
              )
            })}
          </ScrollRow>
        )}
      </div>

      {/* ── Avatar modal ── */}
      {showImageModal && thumbUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setShowImageModal(false)}
        >
          <img
            src={thumbUrl}
            alt={artist.title}
            className="max-h-[85vh] max-w-[85vw] rounded-2xl shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}

      {/* ── Hero image modal ── */}
      {showHeroModal && artUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
          onClick={() => setShowHeroModal(false)}
        >
          <img
            src={artUrl}
            alt={artist.title}
            className="max-h-[95vh] max-w-[95vw] rounded-lg shadow-2xl object-contain"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
