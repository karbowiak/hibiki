import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Link } from "wouter"
import { open } from "@tauri-apps/plugin-shell"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore, useUIStore, useLibraryStore } from "../../stores"
import { useProviderStore } from "../../stores/providerStore"
import { prefetchTrackAudio } from "../../stores/playerStore"
import { useContextMenu } from "../../hooks/useContextMenu"
import { useFocalPoint } from "../../lib/focalPoint"
import type { MusicArtist, MusicAlbum, MusicTrack, MusicHub, MusicPlaylist } from "../../types/music"
import { MediaCard } from "../MediaCard"
import { ScrollRow } from "../ScrollRow"
import { UltraBlur } from "../UltraBlur"
import { getCachedArtist, prefetchAlbum, prefetchArtist, setArtistCache } from "../../stores/metadataCache"
import { useDeezerMetadataStore } from "../../backends/deezer/store"
import { useArtistEnrichment } from "../../hooks/useMetadataEnrichment"
import { buildImageUrl, buildExternalImageUrl } from "../../lib/imageUrl"
import { formatMs } from "../../lib/formatters"
import { ImageModal } from "../shared/ImageModal"
import { deduplicateAlbums, deduplicateHubAlbums, collectAllIds } from "../../lib/dedup"
import { useMetadataSourceStore } from "../../stores/metadataSourceStore"
import { HeroRating } from "../HeroRating"
import { StarRating } from "../shared/StarRating"
import { useDebugStore } from "../../stores/debugStore"
import { useDebugPanelStore } from "../../stores/debugPanelStore"
import { useCapability } from "../../hooks/useCapability"


function dedupe<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter(item => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
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

  const cachedUrl = buildExternalImageUrl(imageUrl)
  if (cachedUrl) {
    return <img src={cachedUrl} alt={name} className="h-16 w-16 rounded-full object-cover" />
  }
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-xl font-bold text-white/30">
      {name[0]}
    </div>
  )
}

export function ArtistPage({ artistId }: { artistId: string }) {
  const provider = useProviderStore(s => s.provider)
  const { playTrack, playFromUri, playRadio, addToQueue, currentTrack } = usePlayerStore(useShallow(s => ({ playTrack: s.playTrack, playFromUri: s.playFromUri, playRadio: s.playRadio, addToQueue: s.addToQueue, currentTrack: s.currentTrack })))
  const { handler: ctxMenu, isTarget: isCtxTarget } = useContextMenu()
  const pageRefreshKey = useUIStore(s => s.pageRefreshKey)
  const hasRadio = useCapability("radio")
  const hasSonicSimilarity = useCapability("sonicSimilarity")

  const cached = getCachedArtist(artistId)
  const [artist, setArtist] = useState<MusicArtist | null>(cached?.artist ?? null)
  const [fullAlbums, setFullAlbums] = useState<MusicAlbum[]>(cached?.albums ?? [])
  const [singles, setSingles] = useState<MusicAlbum[]>(cached?.singles ?? [])
  const [popularTracks, setPopularTracks] = useState<MusicTrack[]>([])
  const [similarArtists, setSimilarArtists] = useState<MusicArtist[]>([])
  const [sonicallySimilar, setSonicallySimilar] = useState<MusicArtist[]>([])
  const [relatedHubs, setRelatedHubs] = useState<MusicHub[]>([])
  const [stations, setStations] = useState<MusicPlaylist[]>([])
  const [isLoading, setIsLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)

  // UI state
  const [bioExpanded, setBioExpanded] = useState(false)
  const [showImageModal, setShowImageModal] = useState(false)
  const [showHeroModal, setShowHeroModal] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const debugEnabled = useDebugStore(s => s.debugEnabled)
  const showDebugPanel = useDebugPanelStore(s => s.show)

  // Metadata source priority
  const priority = useMetadataSourceStore(s => s.priority)
  const { tagsGenre, tagsMood, tagsStyle } = useLibraryStore(useShallow(s => ({
    tagsGenre: s.tagsGenre,
    tagsMood: s.tagsMood,
    tagsStyle: s.tagsStyle,
  })))

  // Enrichment metadata from all backends
  const { lastfm: lastfmData, deezer: deezerData, itunes: itunesData } = useArtistEnrichment(artist?.title ?? null)

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
    if (!provider) return
    Promise.all([
      provider.getArtist(artistId),
      provider.getArtistAlbumsInSection ? provider.getArtistAlbumsInSection(artistId) : provider.getArtistAlbums(artistId),
      provider.getArtistAlbumsInSection ? provider.getArtistAlbumsInSection(artistId, "EP,Single") : Promise.resolve([] as MusicAlbum[]),
      provider.getArtistPopularTracksInSection ? provider.getArtistPopularTracksInSection(artistId, 15) : provider.getArtistPopularTracks(artistId, 15),
      provider.getArtistSimilar(artistId).catch(() => [] as MusicArtist[]),
      provider.getArtistSonicallySimilar ? provider.getArtistSonicallySimilar(artistId, 20).catch(() => [] as MusicArtist[]) : Promise.resolve([] as MusicArtist[]),
      provider.getRelatedHubs(artistId).catch(() => [] as MusicHub[]),
      provider.getArtistStations ? provider.getArtistStations(artistId).catch(() => [] as MusicPlaylist[]) : Promise.resolve([] as MusicPlaylist[]),
    ])
      .then(([a, allAlbums, singleList, tracks, sim, sonic, hubs, stationList]) => {
        const dedupedSingles = deduplicateAlbums(singleList)
        const singleKeys = collectAllIds(dedupedSingles)
        const albums = deduplicateAlbums(allAlbums).filter(a =>
          !singleKeys.has(a.id) && !(a._alternateIds ?? []).some(id => singleKeys.has(id))
        )
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
  }, [artistId, pageRefreshKey])

  // Compute artUrl before early returns so useFocalPoint can be called unconditionally.
  // Respect source priority — iterate through priority order, pick first source with an image.
  const plexArt   = artist?.artUrl ?? null
  const deezerUrl = deezerData?.image_url ? buildImageUrl("artist", artistId, deezerData.image_url, artist?.title) : null
  let artUrl: string | null = null
  for (const src of priority) {
    if (src === "plex"   && plexArt)   { artUrl = plexArt;   break }
    if (src === "deezer" && deezerUrl) { artUrl = deezerUrl; break }
  }
  if (!artUrl) artUrl = plexArt ?? deezerUrl ?? null
  const heroBgPos = useFocalPoint(artUrl)

  // Map from lowercase artist name → provider ID for "Fans Also Like" linking.
  // Covers both Plex-similar and sonically-similar artists that are in the library.
  const plexArtistMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of [...similarArtists, ...sonicallySimilar]) {
      map.set(a.title.toLowerCase(), a.id)
    }
    return map
  }, [similarArtists, sonicallySimilar])

  // Must be before early returns — hooks cannot be called conditionally.
  const plexTagSet = useMemo(
    () => new Set([...tagsGenre, ...tagsMood, ...tagsStyle].map(t => t.tag.toLowerCase())),
    [tagsGenre, tagsMood, tagsStyle]
  )

  // Memoize album/hub filtering — depends on relatedHubs, fullAlbums, singles
  const { albumHubs, displayAlbums, displaySingles, genres } = useMemo(() => {
    const albumHubs = relatedHubs
      .filter(h =>
        h.identifier && !SKIP_HUB_IDS.has(h.identifier) &&
        h.items.some(m => m.type === "album")
      )
      .map(deduplicateHubAlbums)
    const hubAlbumKeys = new Set(
      albumHubs.flatMap(h => h.items.filter(m => m.type === "album").map(m => m.id))
    )
    const hasId = (id: string) => hubAlbumKeys.has(id)
    const da = fullAlbums.filter(a => !hasId(a.id) && !(a._alternateIds ?? []).some(hasId))
    const ds = singles.filter(a => !hasId(a.id) && !(a._alternateIds ?? []).some(hasId))

    const g: string[] = []
    const seenGenres = new Set<string>()
    for (const album of [...fullAlbums, ...singles]) {
      for (const gn of album.genres) {
        if (!seenGenres.has(gn)) { seenGenres.add(gn); g.push(gn) }
      }
    }
    return { albumHubs, displayAlbums: da, displaySingles: ds, genres: g }
  }, [relatedHubs, fullAlbums, singles])

  // Count how many duplicate albums were merged (for the hero badge)
  const dedupStats = useMemo(() => {
    const countAlts = (list: MusicAlbum[]) => list.reduce((n, a) => n + (a._alternateIds?.length ?? 0), 0)
    const albumDupes = countAlts(fullAlbums)
    const singleDupes = countAlts(singles)
    const hubDupes = relatedHubs.reduce((n, h) =>
      n + h.items.filter(i => i.type === "album").reduce((m, a) => m + ((a as MusicAlbum)._alternateIds?.length ?? 0), 0), 0)
    const total = albumDupes + singleDupes + hubDupes
    if (total === 0) return null
    const parts: string[] = []
    if (albumDupes > 0) parts.push(`${albumDupes} album${albumDupes > 1 ? "s" : ""}`)
    if (singleDupes > 0) parts.push(`${singleDupes} single${singleDupes > 1 ? "s" : ""}`)
    if (hubDupes > 0) parts.push(`${hubDupes} other`)
    return `deduplicated: ${parts.join(", ")}`
  }, [fullAlbums, singles, relatedHubs])

  if (isLoading) return <div className="p-8 text-sm text-gray-400">Loading artist…</div>
  if (error) return <div className="p-8 text-sm text-red-400">{error}</div>
  if (!artist) return null

  const plexThumb = artist.thumbUrl ?? null
  let thumbUrl: string | null = null
  for (const src of priority) {
    if (src === "plex"   && plexThumb) { thumbUrl = plexThumb; break }
    if (src === "deezer" && deezerUrl) { thumbUrl = deezerUrl; break }
  }
  if (!thumbUrl) thumbUrl = plexThumb ?? deezerUrl ?? null

  const artistUri = provider?.buildItemUri
    ? provider.buildItemUri(`/library/metadata/${artistId}`)
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
          {hasRadio && <button
            onClick={() => void playRadio(artistId, 'artist', artist.title)}
            title="Artist Radio — continuous sonically-similar music"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-accent hover:bg-black/45 hover:scale-105 active:scale-95 transition-all"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
            </svg>
          </button>}
          {/* Three-dot menu */}
          <div className="relative">
            <button
              ref={menuBtnRef}
              onClick={() => setMenuOpen(v => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-white/50 hover:text-white hover:bg-white/10 transition-all"
              title="More options"
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                <circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/>
              </svg>
            </button>
            {artist && menuOpen && (() => {
              const rect = menuBtnRef.current?.getBoundingClientRect()
              return createPortal(<>
                <div className="fixed inset-0 z-[9998]" onClick={() => setMenuOpen(false)} />
                <div
                  className="fixed z-[9999] w-56 max-h-[70vh] overflow-y-auto rounded-lg bg-app-surface shadow-xl border border-[var(--border)] py-1"
                  style={{ top: (rect?.bottom ?? 0) + 4, right: window.innerWidth - (rect?.right ?? 0) }}
                >
                  {/* Queue */}
                  <button
                    onClick={() => { addToQueue(popularTracks); setMenuOpen(false) }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" /></svg>
                    Add popular to queue
                  </button>

                  <hr className="my-1 border-t border-[var(--border)]" />

                  {/* Rating */}
                  <StarRating
                    itemId={artist.id}
                    userRating={artist.userRating ?? null}
                    enableLove={false}
                    artist={artist.title}
                    track=""
                    size={14}
                    onRated={() => setMenuOpen(false)}
                  />

                  <hr className="my-1 border-t border-[var(--border)]" />

                  {/* Share */}
                  <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/30">Share</div>
                  <button
                    onClick={() => { void open(`https://www.last.fm/music/${encodeURIComponent(artist.title)}`); setMenuOpen(false) }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" /></svg>
                    Last.fm
                  </button>
                  {deezerData?.deezer_url && (
                    <button
                      onClick={() => { void open(deezerData.deezer_url); setMenuOpen(false) }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" /></svg>
                      Deezer
                    </button>
                  )}

                  {/* Debug */}
                  {debugEnabled && (
                    <>
                      <hr className="my-1 border-t border-[var(--border)]" />
                      <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/30">Debug</div>
                      <button
                        onClick={() => { showDebugPanel("artist", artist); setMenuOpen(false) }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20 8h-2.81a5.985 5.985 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17a5.947 5.947 0 0 0-2.84 0L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81A6.008 6.008 0 0 0 12 22a6.008 6.008 0 0 0 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z"/></svg>
                        Debug Info
                      </button>
                    </>
                  )}
                </div>
              </>, document.body)
            })()}
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
            <HeroRating itemId={artistId} userRating={artist.userRating} itemType="artist" />

            {/* Metadata stats row */}
            {(lastfmData || deezerData || dedupStats) && (
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
                {dedupStats && (
                  <>
                    {(lastfmData || deezerData) && <span className="text-gray-700">·</span>}
                    <span className="italic text-gray-600">{dedupStats}</span>
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
                const albumId = track.albumId
                const isActive = currentTrack?.id === track.id
                const isContextTarget = isCtxTarget(track.id)
                return (
                  <div
                    key={`${track.id}-${i}`}
                    onClick={() => playTrack(track, popularTracks, artist.title, `/artist/${artistId}`)}
                    onMouseEnter={() => prefetchTrackAudio(track)}
                    onContextMenu={ctxMenu("track", track)}
                    className={`group flex cursor-pointer items-center gap-3 rounded-md px-3 py-1.5 ${isActive || isContextTarget ? "bg-hl-menu" : "hover:bg-hl-menu"}`}
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
                              {track.albumName}
                            </Link>
                          </span>
                        )}
                      </div>
                      {track.originalTitle && track.originalTitle !== artist.title && (
                        <span className="text-xs text-gray-500">{track.originalTitle}</span>
                      )}
                    </div>
                    <span onClick={e => e.stopPropagation()}>
                      <HeroRating itemId={track.id} userRating={track.userRating} />
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
                      {hasRadio && <button
                        className="hidden group-hover:flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors"
                        title="Track Radio"
                        onClick={e => { e.stopPropagation(); void playRadio(track.id, 'track') }}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                        </svg>
                        Radio
                      </button>}
                      <span className="text-xs tabular-nums text-gray-400 group-hover:hidden">
                        {formatMs(track.duration)}
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
                key={album.id}
                title={album.title}
                desc={String(album.year)}
                thumb={album.thumbUrl}
                href={`/album/${album.id}`}
                prefetch={() => prefetchAlbum(album.id)}
                onPlay={() => {
                  const uri = provider?.buildItemUri?.(`/library/metadata/${album.id}`)
                  if (uri) void playFromUri(uri, false, album.title, `/album/${album.id}`)
                }}
                onContextMenu={ctxMenu("album", album)}
                scrollItem
              />
            ))}
          </ScrollRow>
        )}

        {displaySingles.length > 0 && (
          <ScrollRow title="Singles & EPs" restoreKey={`artist-${artistId}-singles`}>
            {displaySingles.map(album => (
              <MediaCard
                key={album.id}
                title={album.title}
                desc={`Single · ${album.year}`}
                thumb={album.thumbUrl}
                href={`/album/${album.id}`}
                prefetch={() => prefetchAlbum(album.id)}
                onPlay={() => {
                  const uri = provider?.buildItemUri?.(`/library/metadata/${album.id}`)
                  if (uri) void playFromUri(uri, false, album.title, `/album/${album.id}`)
                }}
                onContextMenu={ctxMenu("album", album)}
                scrollItem
              />
            ))}
          </ScrollRow>
        )}

        {albumHubs.map(hub => {
          const albums = hub.items.filter(m => m.type === "album")
          if (albums.length === 0) return null
          return (
            <ScrollRow
              key={hub.identifier}
              title={hub.title}
              restoreKey={`artist-${artistId}-${hub.identifier}`}
            >
              {albums.map(a => (
                <MediaCard
                  key={a.id}
                  title={a.title}
                  desc={String(a.year)}
                  thumb={a.thumbUrl}
                  href={`/album/${a.id}`}
                  prefetch={() => prefetchAlbum(a.id)}
                  onPlay={() => {
                    const uri = provider?.buildItemUri?.(`/library/metadata/${a.id}`)
                    if (uri) void playFromUri(uri, false, a.title, `/album/${a.id}`)
                  }}
                  onContextMenu={ctxMenu("album", a)}
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
                key={a.id}
                title={a.title}
                desc="Artist"
                thumb={a.thumbUrl}
                href={`/artist/${a.id}`}
                prefetch={() => prefetchArtist(a.id)}
                onPlay={() => {
                  const uri = provider?.buildItemUri?.(`/library/metadata/${a.id}`)
                  if (uri) void playFromUri(uri, false, a.title, `/artist/${a.id}`)
                }}
                onContextMenu={ctxMenu("artist", a)}
                isArtist
                scrollItem
              />
            ))}
          </ScrollRow>
        )}

        {/* When Last.fm is top priority, hide Plex sonic similar (Last.fm similar shown below) */}
        {hasSonicSimilarity && priority[0] !== "lastfm" && sonicallySimilar.length > 0 && (
          <ScrollRow title="Sonically Similar Artists" restoreKey={`artist-${artistId}-sonic`}>
            {sonicallySimilar.map(a => {
              const distance = a.distance
              const matchPct = distance != null ? `${Math.round((1 - distance) * 100)}% match` : "Artist"
              return (
                <MediaCard
                  key={a.id}
                  title={a.title}
                  desc={matchPct}
                  thumb={a.thumbUrl}
                  href={`/artist/${a.id}`}
                  prefetch={() => prefetchArtist(a.id)}
                  onPlay={() => {
                    const uri = provider?.buildItemUri?.(`/library/metadata/${a.id}`)
                    if (uri) void playFromUri(uri, false, a.title, `/artist/${a.id}`)
                  }}
                  onContextMenu={ctxMenu("artist", a)}
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

      {showImageModal && thumbUrl && (
        <ImageModal src={thumbUrl} alt={artist.title} onClose={() => setShowImageModal(false)} />
      )}
      {showHeroModal && artUrl && (
        <ImageModal src={artUrl} alt={artist.title} onClose={() => setShowHeroModal(false)} overlay="dark" />
      )}
    </div>
  )
}
