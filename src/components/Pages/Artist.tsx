import { useEffect, useMemo, useState } from "react"
import { Link } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { useConnectionStore, buildPlexImageUrl, usePlayerStore, useUIStore, useLibraryStore } from "../../stores"
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
import { prefetchTrackAudio } from "../../stores/playerStore"
import { useContextMenuStore } from "../../stores/contextMenuStore"
import { useFocalPoint } from "../../lib/focalPoint"
import type { Artist, Album, Track, Hub, Playlist } from "../../types/plex"
import { MediaCard } from "../MediaCard"
import { ScrollRow } from "../ScrollRow"
import { UltraBlur } from "../UltraBlur"
import { getCachedArtist, prefetchAlbum, prefetchArtist, setArtistCache } from "../../stores/metadataCache"
import { useLastfmMetadataStore } from "../../stores/lastfmMetadataStore"
import type { LastfmArtistInfo } from "../../lib/lastfm"
import { useDeezerMetadataStore } from "../../stores/deezerMetadataStore"
import type { DeezerArtistInfo } from "../../lib/deezer"
import { useItunesMetadataStore } from "../../stores/itunesMetadataStore"
import type { ItunesArtistInfo } from "../../lib/itunes"
import { buildMetaImageUrl } from "../../lib/metadataImage"
import { useMetadataSourceStore } from "../../stores/metadataSourceStore"
import { HeroRating } from "../HeroRating"

function fmtDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
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

/** Avatar for a LastFM similar artist — lazily fetches the image from Deezer. */
function DeezerArtistAvatar({ name }: { name: string }) {
  const getDeezerArtist = useDeezerMetadataStore(s => s.getArtist)
  const [imageUrl, setImageUrl] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void getDeezerArtist(name).then(d => {
      if (!cancelled) setImageUrl(d?.image_url ?? null)
    })
    return () => { cancelled = true }
  }, [name, getDeezerArtist])

  const cachedUrl = buildMetaImageUrl(imageUrl)
  if (cachedUrl) {
    return <img src={cachedUrl} alt={name} className="h-16 w-16 rounded-full object-cover" />
  }
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-xl font-bold text-white/30">
      {name[0]}
    </div>
  )
}

export function ArtistPage({ artistId }: { artistId: number }) {
  const { baseUrl, token, musicSectionId, sectionUuid } = useConnectionStore()
  const { playTrack, playFromUri, playRadio, addToQueue, currentTrack } = usePlayerStore(useShallow(s => ({ playTrack: s.playTrack, playFromUri: s.playFromUri, playRadio: s.playRadio, addToQueue: s.addToQueue, currentTrack: s.currentTrack })))
  const showContextMenu = useContextMenuStore(s => s.show)
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
  const [menuOpen, setMenuOpen] = useState(false)

  // Metadata source priority
  const priority = useMetadataSourceStore(s => s.priority)
  const { tagsGenre, tagsMood, tagsStyle } = useLibraryStore(useShallow(s => ({
    tagsGenre: s.tagsGenre,
    tagsMood: s.tagsMood,
    tagsStyle: s.tagsStyle,
  })))

  // LastFM metadata
  const getLastfmArtist = useLastfmMetadataStore(s => s.getArtist)
  const [lastfmData, setLastfmData] = useState<LastfmArtistInfo | null>(null)

  // Deezer metadata
  const getDeezerArtist = useDeezerMetadataStore(s => s.getArtist)
  const [deezerData, setDeezerData] = useState<DeezerArtistInfo | null>(null)

  // iTunes metadata
  const getItunesArtist = useItunesMetadataStore(s => s.getArtist)
  const [itunesData, setItunesData] = useState<ItunesArtistInfo | null>(null)

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

  // Fetch LastFM + Deezer + iTunes metadata once we know the artist name
  useEffect(() => {
    if (!artist?.title) return
    let cancelled = false
    setLastfmData(null)
    setDeezerData(null)
    setItunesData(null)
    void getLastfmArtist(artist.title).then(d => {
      if (!cancelled && d) setLastfmData(d)
    })
    void getDeezerArtist(artist.title).then(d => {
      if (!cancelled && d) setDeezerData(d)
    })
    void getItunesArtist(artist.title).then(d => {
      if (!cancelled && d) setItunesData(d)
    })
    return () => { cancelled = true }
  }, [artist?.title, getLastfmArtist, getDeezerArtist, getItunesArtist])

  // Compute artUrl before early returns so useFocalPoint can be called unconditionally.
  // Respect source priority — iterate through priority order, pick first source with an image.
  const plexArt   = artist?.art ? buildPlexImageUrl(baseUrl, token, artist.art) : null
  const deezerUrl = buildMetaImageUrl(deezerData?.image_url)
  let artUrl: string | null = null
  for (const src of priority) {
    if (src === "plex"   && plexArt)   { artUrl = plexArt;   break }
    if (src === "deezer" && deezerUrl) { artUrl = deezerUrl; break }
  }
  if (!artUrl) artUrl = plexArt ?? deezerUrl ?? null
  const heroBgPos = useFocalPoint(artUrl)

  // Map from lowercase artist name → Plex ratingKey for "Fans Also Like" linking.
  // Covers both Plex-similar and sonically-similar artists that are in the library.
  const plexArtistMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of [...similarArtists, ...sonicallySimilar]) {
      map.set(a.title.toLowerCase(), a.rating_key)
    }
    return map
  }, [similarArtists, sonicallySimilar])

  // Must be before early returns — hooks cannot be called conditionally.
  const plexTagSet = useMemo(
    () => new Set([...tagsGenre, ...tagsMood, ...tagsStyle].map(t => t.tag.toLowerCase())),
    [tagsGenre, tagsMood, tagsStyle]
  )

  if (isLoading) return <div className="p-8 text-sm text-gray-400">Loading artist…</div>
  if (error) return <div className="p-8 text-sm text-red-400">{error}</div>
  if (!artist) return null

  const plexThumb = artist.thumb ? buildPlexImageUrl(baseUrl, token, artist.thumb) : null
  let thumbUrl: string | null = null
  for (const src of priority) {
    if (src === "plex"   && plexThumb) { thumbUrl = plexThumb; break }
    if (src === "deezer" && deezerUrl) { thumbUrl = deezerUrl; break }
  }
  if (!thumbUrl) thumbUrl = plexThumb ?? deezerUrl ?? null

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

  // Bio: pick from the highest-priority source that has text.
  // Only Plex and Last.fm have artist bios; Deezer and Apple are skipped.
  let displayBio: string | undefined
  for (const src of priority) {
    if (src === "lastfm" && lastfmData?.bio)  { displayBio = lastfmData.bio;  break }
    if (src === "plex"   && artist.summary)   { displayBio = artist.summary;  break }
  }

  // Merge tags in priority order; Plex genres always valid; external tags filtered.
  const tagsBySource: Record<string, string[]> = {
    plex:   genres,
    lastfm: (lastfmData?.tags ?? []).filter(t => plexTagSet.has(t.toLowerCase())),
    deezer: [],   // artist info has no genre tags
    apple:  itunesData?.genre && plexTagSet.has(itunesData.genre.toLowerCase())
      ? [itunesData.genre] : [],
  }
  const seenTags = new Set<string>()
  const mergedTags: string[] = []
  for (const src of priority) {
    for (const tag of (tagsBySource[src] ?? [])) {
      const key = tag.toLowerCase()
      if (!seenTags.has(key)) { seenTags.add(key); mergedTags.push(tag) }
    }
  }
  const heroTags = mergedTags.slice(0, 8)

  return (
    <div>
      {/* ── Hero ── */}
      <div
        className="relative flex items-end bg-cover p-8 transition-[min-height] duration-500 ease-in-out min-h-80 hero-overlay"
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
        <div className="absolute bottom-8 right-8 z-20 flex items-center gap-3">
          {/* Play */}
          <button
            onClick={() => artistUri && void playFromUri(artistUri, false, artist.title, `/artist/${artistId}`)}
            disabled={!artistUri}
            title="Play"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-accent hover:bg-black/45 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor">
              <polygon points="3,2 13,8 3,14" />
            </svg>
          </button>
          {/* Shuffle */}
          <button
            onClick={() => artistUri && void playFromUri(artistUri, true, artist.title, `/artist/${artistId}`)}
            disabled={!artistUri}
            title="Shuffle play"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-accent hover:bg-black/45 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356A2.25 2.25 0 0 1 11.16 4.5h1.949l-1.018 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5zm9.831 8.17l.979 1.167.28.334A3.75 3.75 0 0 0 14.36 14.5h1.64V13h-1.64a2.25 2.25 0 0 1-1.726-.83l-.28-.335-1.733-2.063-.979 1.167 1.18 1.731z" />
            </svg>
          </button>
          {/* Artist Radio */}
          <button
            onClick={() => void playRadio(artistId, 'artist', artist.title)}
            title="Artist Radio — continuous sonically-similar music"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-accent hover:bg-black/45 hover:scale-105 active:scale-95 transition-all"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
            </svg>
          </button>
          {/* Three-dot menu */}
          <div className="relative">
            <button
              onClick={() => setMenuOpen(v => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-white/50 hover:text-white hover:bg-white/10 transition-all"
              title="More options"
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                <circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/>
              </svg>
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-lg bg-app-surface shadow-xl border border-[var(--border)] py-1">
                  <button
                    onClick={() => { addToQueue(popularTracks); setMenuOpen(false) }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                      <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/>
                    </svg>
                    Add popular tracks to Queue
                  </button>
                </div>
              </>
            )}
          </div>
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
            <div className="h-36 w-36 flex-shrink-0 rounded-full bg-app-surface shadow-2xl" />
          )}

          {/* Info column — no fixed height, flows naturally */}
          <div className="flex min-w-0 flex-1 flex-col gap-2 pr-72">
            <div className="text-xs font-semibold uppercase tracking-widest text-gray-300">Artist</div>
            <h1 className="text-5xl font-black leading-none text-white select-text">{artist.title}</h1>

            {heroTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {heroTags.map(g => (
                  <Link
                    key={g}
                    href={`/genre/genre/${encodeURIComponent(g)}`}
                    className="rounded-full bg-white/10 px-3 py-0.5 text-xs text-gray-300 hover:bg-white/20 hover:text-white transition-colors"
                  >
                    {g}
                  </Link>
                ))}
              </div>
            )}

            {/* Expandable bio */}
            {displayBio && (
              <div
                className="cursor-pointer select-text"
                onClick={() => setBioExpanded(v => !v)}
                title={bioExpanded ? "Collapse" : "Expand"}
              >
                <div
                  className="overflow-hidden transition-all duration-500 ease-in-out"
                  style={{ maxHeight: bioExpanded ? "500px" : "2.8rem" }}
                >
                  <p className="text-sm leading-relaxed text-gray-300">{displayBio}</p>
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

            {/* Rating */}
            <HeroRating ratingKey={artistId} userRating={artist.user_rating} />

            {/* Metadata stats row */}
            {(lastfmData || deezerData) && (
              <div className="mt-0.5 flex items-center gap-3 text-xs text-gray-500">
                {lastfmData && lastfmData.listeners > 0 && (
                  <span>{lastfmData.listeners.toLocaleString()} listeners</span>
                )}
                {lastfmData && lastfmData.play_count > 0 && (
                  <span>{lastfmData.play_count.toLocaleString()} scrobbles</span>
                )}
                {lastfmData && (lastfmData.listeners > 0 || lastfmData.play_count > 0) && (
                  <span className="text-gray-600">· Last.fm</span>
                )}
                {deezerData && deezerData.fans > 0 && (
                  <>
                    {lastfmData && <span className="text-gray-700">·</span>}
                    <span>{deezerData.fans.toLocaleString()} fans</span>
                    <span className="text-gray-600">· Deezer</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-10 p-8">
        {/* ── Popular Tracks ── */}
        {popularTracks.length > 0 && (
          <section>
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-2xl font-bold">Popular Tracks</h2>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => void playTrack(popularTracks[0], popularTracks, artist.title, `/artist/${artistId}`)}
                  title="Play popular tracks"
                  className="group flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-all duration-200 hover:border-accent hover:bg-accent/20 active:scale-95"
                >
                  <svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor" className="transition-transform duration-200 group-hover:scale-110">
                    <polygon points="3,2 13,8 3,14" />
                  </svg>
                  Play
                </button>
                <button
                  onClick={() => { const s = [...popularTracks].sort(() => Math.random() - 0.5); void playTrack(s[0], s, artist.title, `/artist/${artistId}`) }}
                  title="Shuffle popular tracks"
                  className="group flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold text-gray-300 transition-all duration-200 hover:border-white/30 hover:bg-white/10 hover:text-white active:scale-95"
                >
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" className="transition-transform duration-200 group-hover:scale-110">
                    <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
                    <path d="m7.5 10.723.98-1.167.957 1.14a2.25 2.25 0 0 0 1.724.804h1.947l-1.017-1.018a.75.75 0 1 1 1.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 1 1-1.06-1.06L13.109 13H11.16a3.75 3.75 0 0 1-2.873-1.34l-.787-.938z" />
                  </svg>
                  Shuffle
                </button>
              </div>
            </div>
            <div className="flex flex-col">
              {popularTracks.map((track, i) => {
                const albumId = track.parent_key ? track.parent_key.split("/").pop() : null
                const isActive = currentTrack?.rating_key === track.rating_key
                return (
                  <div
                    key={track.rating_key}
                    onClick={() => playTrack(track, popularTracks, artist.title, `/artist/${artistId}`)}
                    onMouseEnter={() => prefetchTrackAudio(track)}
                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, "track", track) }}
                    className={`group flex cursor-pointer items-center gap-3 rounded-md px-3 py-1.5 ${isActive ? "bg-white/10" : "hover:bg-white/10"}`}
                  >
                    {isActive ? (
                      <>
                        <span className="w-5 flex-shrink-0 flex items-center justify-center group-hover:hidden text-accent">
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                            <rect x="1" y="3" width="3" height="10" rx="1"/><rect x="6" y="1" width="3" height="12" rx="1"/><rect x="11" y="5" width="3" height="8" rx="1"/>
                          </svg>
                        </span>
                        <span className="hidden w-5 flex-shrink-0 group-hover:flex items-center justify-center text-accent">
                          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><polygon points="3,2 13,8 3,14" /></svg>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="w-5 flex-shrink-0 text-right text-sm text-gray-400 group-hover:hidden">
                          {i + 1}
                        </span>
                        <span className="hidden w-5 flex-shrink-0 group-hover:flex items-center justify-center">
                          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                            <polygon points="3,2 13,8 3,14" />
                          </svg>
                        </span>
                      </>
                    )}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-center gap-1.5">
                        <span className={`min-w-0 truncate text-sm font-medium ${isActive ? "text-accent" : "text-white"}`}>
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
                      {track.original_title && track.original_title !== artist.title && (
                        <span className="text-xs text-gray-500">{track.original_title}</span>
                      )}
                    </div>
                    <span onClick={e => e.stopPropagation()}>
                      <HeroRating ratingKey={track.rating_key} userRating={track.user_rating} />
                    </span>
                    <span className="w-32 flex-shrink-0 flex items-center justify-end gap-2">
                      <button
                        className="hidden group-hover:flex items-center gap-0.5 text-xs text-gray-400 hover:text-white transition-colors"
                        title="Add to Queue"
                        onClick={e => { e.stopPropagation(); addToQueue([track]) }}
                      >
                        <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                          <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/>
                        </svg>
                        Queue
                      </button>
                      <button
                        className="hidden group-hover:flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors"
                        title="Track Radio"
                        onClick={e => { e.stopPropagation(); void playRadio(track.rating_key, 'track') }}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                        </svg>
                        Radio
                      </button>
                      <span className="text-xs tabular-nums text-gray-400 group-hover:hidden">
                        {fmtDuration(track.duration)}
                      </span>
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
                onPlay={() => sectionUuid && void playFromUri(
                  buildItemUri(sectionUuid, `/library/metadata/${album.rating_key}`),
                  false, album.title, `/album/${album.rating_key}`
                )}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, "album", album) }}
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
                onPlay={() => sectionUuid && void playFromUri(
                  buildItemUri(sectionUuid, `/library/metadata/${album.rating_key}`),
                  false, album.title, `/album/${album.rating_key}`
                )}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, "album", album) }}
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
                  onPlay={() => sectionUuid && void playFromUri(
                    buildItemUri(sectionUuid, `/library/metadata/${a.rating_key}`),
                    false, a.title, `/album/${a.rating_key}`
                  )}
                  onContextMenu={e => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, "album", a) }}
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
                onPlay={() => sectionUuid && void playFromUri(
                  buildItemUri(sectionUuid, `/library/metadata/${a.rating_key}`),
                  false, a.title, `/artist/${a.rating_key}`
                )}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, "artist", a) }}
                isArtist
                scrollItem
              />
            ))}
          </ScrollRow>
        )}

        {/* When Last.fm is top priority, hide Plex sonic similar (Last.fm similar shown below) */}
        {priority[0] !== "lastfm" && sonicallySimilar.length > 0 && (
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
                  onPlay={() => sectionUuid && void playFromUri(
                    buildItemUri(sectionUuid, `/library/metadata/${a.rating_key}`),
                    false, a.title, `/artist/${a.rating_key}`
                  )}
                  onContextMenu={e => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, "artist", a) }}
                  isArtist
                  scrollItem
                />
              )
            })}
          </ScrollRow>
        )}

        {/* ── Last.fm Similar Artists (images from Deezer) ── */}
        {lastfmData && lastfmData.similar.length > 0 && (
          <section>
            <h2 className="mb-4 text-xl font-bold">
              {priority[0] === "lastfm" ? "Similar Artists" : "Fans Also Like"}
              <span className="ml-2 text-xs font-normal text-gray-500">via Last.fm</span>
            </h2>
            <div className="flex flex-wrap gap-4">
              {lastfmData.similar.map(a => {
                const plexId = plexArtistMap.get(a.name.toLowerCase())
                const avatar = <DeezerArtistAvatar name={a.name} />
                return (
                  <div key={a.name} className="flex w-20 flex-col items-center gap-1.5">
                    {plexId ? (
                      <Link
                        href={`/artist/${plexId}`}
                        className="block rounded-full ring-2 ring-transparent hover:ring-white/40 transition-all"
                        title={`Open ${a.name}`}
                      >
                        {avatar}
                      </Link>
                    ) : (
                      <div className="opacity-40">{avatar}</div>
                    )}
                    <span className={`line-clamp-2 text-center text-xs leading-tight ${plexId ? "text-gray-300" : "text-gray-500"}`}>
                      {a.name}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
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
