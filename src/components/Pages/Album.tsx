import { useEffect, useMemo, useState } from "react"
import { Link } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { useConnectionStore, usePlayerStore, buildPlexImageUrl, useUIStore, useLibraryStore } from "../../stores"
import { getAlbum, getAlbumTracks, getRelatedHubs } from "../../lib/plex"
import { prefetchTrackAudio } from "../../stores/playerStore"
import { useContextMenuStore } from "../../stores/contextMenuStore"
import type { Album, Artist, Track, Hub, PlexTag } from "../../types/plex"
import { MediaCard } from "../MediaCard"
import { ScrollRow } from "../ScrollRow"
import { UltraBlur } from "../UltraBlur"
import { getCachedAlbum, prefetchAlbum, prefetchArtist, setAlbumCache } from "../../stores/metadataCache"
import { useLastfmMetadataStore } from "../../stores/lastfmMetadataStore"
import type { LastfmAlbumInfo } from "../../lib/lastfm"
import { useDeezerMetadataStore } from "../../stores/deezerMetadataStore"
import type { DeezerAlbumInfo } from "../../lib/deezer"
import { useItunesMetadataStore } from "../../stores/itunesMetadataStore"
import type { ItunesAlbumInfo } from "../../lib/itunes"
import { buildMetaImageUrl } from "../../lib/metadataImage"
import { useMetadataSourceStore } from "../../stores/metadataSourceStore"
import { HeroRating } from "../HeroRating"

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`
}

function formatTotalDuration(tracks: Track[]): string {
  const totalMs = tracks.reduce((sum, t) => sum + t.duration, 0)
  const totalSec = Math.floor(totalMs / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function TagChip({ tag, tagType }: { tag: PlexTag; tagType: "genre" | "mood" | "style" }) {
  return (
    <Link
      href={`/genre/${tagType}/${encodeURIComponent(tag.tag)}`}
      className="rounded-full border border-white/20 px-2.5 py-0.5 text-xs text-gray-300 hover:border-white/40 hover:text-white transition-colors"
    >
      {tag.tag}
    </Link>
  )
}

export function AlbumPage({ albumId }: { albumId: number }) {
  const { baseUrl, token, musicSectionId } = useConnectionStore()
  const { playTrack, playRadio, addToQueue, currentTrack } = usePlayerStore(useShallow(s => ({ playTrack: s.playTrack, playRadio: s.playRadio, addToQueue: s.addToQueue, currentTrack: s.currentTrack })))
  const showContextMenu = useContextMenuStore(s => s.show)
  const { pageRefreshKey } = useUIStore()

  // Seed from eager-load cache for an instant first render.
  const cached = getCachedAlbum(albumId)
  const [album, setAlbum] = useState<Album | null>(cached?.album ?? null)
  const [tracks, setTracks] = useState<Track[]>(cached?.tracks ?? [])
  const [relatedHubs, setRelatedHubs] = useState<Hub[]>([])
  const [isLoading, setIsLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)

  // UI state
  const [descExpanded, setDescExpanded] = useState(false)
  const [showImageModal, setShowImageModal] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // Metadata source priority
  const priority = useMetadataSourceStore(s => s.priority)
  const { tagsGenre, tagsMood, tagsStyle } = useLibraryStore(useShallow(s => ({
    tagsGenre: s.tagsGenre,
    tagsMood: s.tagsMood,
    tagsStyle: s.tagsStyle,
  })))

  // LastFM metadata
  const getLastfmAlbum = useLastfmMetadataStore(s => s.getAlbum)
  const [lastfmData, setLastfmData] = useState<LastfmAlbumInfo | null>(null)

  // Deezer metadata
  const getDeezerAlbum = useDeezerMetadataStore(s => s.getAlbum)
  const [deezerData, setDeezerData] = useState<DeezerAlbumInfo | null>(null)

  // iTunes metadata
  const getItunesAlbum = useItunesMetadataStore(s => s.getAlbum)
  const [itunesData, setItunesData] = useState<ItunesAlbumInfo | null>(null)

  useEffect(() => {
    setError(null)
    setDescExpanded(false)
    setShowImageModal(false)

    // Seed ALL state from persistent cache — avoids loading flash.
    const freshCache = getCachedAlbum(albumId)
    if (freshCache) {
      setAlbum(freshCache.album)
      setTracks(freshCache.tracks)
      setRelatedHubs(freshCache.relatedHubs)
      setIsLoading(false)
    } else {
      setAlbum(null)
      setTracks([])
      setRelatedHubs([])
      setIsLoading(true)
    }

    // Always re-fetch for freshness (silently when cache-seeded).
    Promise.all([
      getAlbum(albumId),
      getAlbumTracks(albumId),
      getRelatedHubs(albumId, 20).catch(() => [] as Hub[]),
    ])
      .then(([al, tr, hubs]) => {
        setAlbum(al)
        setTracks(tr)
        setRelatedHubs(hubs)

        // Update persistent cache for next visit / restart
        setAlbumCache(albumId, { album: al, tracks: tr, relatedHubs: hubs })
      })
      .catch(e => setError(String(e)))
      .finally(() => setIsLoading(false))
  }, [albumId, pageRefreshKey])

  // Build set of all Plex-known tags so external tags can be filtered to only
  // those that link to something in the library (genre/mood/style stations).
  const plexTagSet = useMemo(
    () => new Set([...tagsGenre, ...tagsMood, ...tagsStyle].map(t => t.tag.toLowerCase())),
    [tagsGenre, tagsMood, tagsStyle]
  )

  // Fetch LastFM + Deezer + iTunes metadata once we know the album / artist names
  useEffect(() => {
    if (!album?.title || !album?.parent_title) return
    let cancelled = false
    setLastfmData(null)
    setDeezerData(null)
    setItunesData(null)
    void getLastfmAlbum(album.parent_title, album.title).then(d => {
      if (!cancelled && d) setLastfmData(d)
    })
    void getDeezerAlbum(album.parent_title, album.title).then(d => {
      if (!cancelled && d) setDeezerData(d)
    })
    void getItunesAlbum(album.parent_title, album.title).then(d => {
      if (!cancelled && d) setItunesData(d)
    })
    return () => { cancelled = true }
  }, [album?.title, album?.parent_title, getLastfmAlbum, getDeezerAlbum, getItunesAlbum])

  if (isLoading) return <div className="p-8 text-sm text-gray-400">Loading album…</div>
  if (error) return <div className="p-8 text-sm text-red-400">{error}</div>
  if (!album) return null

  const plexThumb   = album.thumb ? buildPlexImageUrl(baseUrl, token, album.thumb) : null
  const deezerCover = buildMetaImageUrl(deezerData?.cover_url)
  const appleCover  = buildMetaImageUrl(itunesData?.cover_url)
  let thumbUrl: string | null = null
  for (const src of priority) {
    if (src === "plex"   && plexThumb)   { thumbUrl = plexThumb;   break }
    if (src === "deezer" && deezerCover) { thumbUrl = deezerCover; break }
    if (src === "apple"  && appleCover)  { thumbUrl = appleCover;  break }
  }
  if (!thumbUrl) thumbUrl = plexThumb ?? deezerCover ?? appleCover ?? null
  const parentThumbUrl = album.parent_thumb
    ? buildPlexImageUrl(baseUrl, token, album.parent_thumb)
    : null

  const formatLabel = album.subformat.length > 0
    ? album.subformat.map(f => f.tag).join(" · ")
    : "Album"

  const plexTags = [
    ...album.genre,
    ...album.style,
    ...album.mood,
  ]

  // Map each tag name (lowercase) to its tagType for building correct genre links.
  const tagTypeMap = useMemo(() => {
    const m = new Map<string, "genre" | "mood" | "style">()
    for (const t of tagsGenre) m.set(t.tag.toLowerCase(), "genre")
    for (const t of tagsMood)  m.set(t.tag.toLowerCase(), "mood")
    for (const t of tagsStyle) m.set(t.tag.toLowerCase(), "style")
    // Album-specific tags override (they are authoritative)
    for (const t of album.genre) m.set(t.tag.toLowerCase(), "genre")
    for (const t of album.style) m.set(t.tag.toLowerCase(), "style")
    for (const t of album.mood)  m.set(t.tag.toLowerCase(), "mood")
    return m
  }, [album.genre, album.style, album.mood, tagsGenre, tagsMood, tagsStyle])

  // Bio: pick from the highest-priority source that has text.
  // Only Plex and Last.fm have album bios/wiki; Deezer and Apple are skipped.
  let displayWiki: string | undefined
  for (const src of priority) {
    if (src === "lastfm" && lastfmData?.wiki) { displayWiki = lastfmData.wiki; break }
    if (src === "plex"   && album.summary)    { displayWiki = album.summary;   break }
  }

  // Merge tags in priority order; Plex tags always valid; external tags filtered.
  const toPlexTag = (tag: string): PlexTag => ({ tag, id: null, filter: null })
  const tagsBySource: Record<string, PlexTag[]> = {
    plex:   plexTags,
    lastfm: (lastfmData?.tags ?? [])
      .filter(t => plexTagSet.has(t.toLowerCase()))
      .map(toPlexTag),
    deezer: (deezerData?.genres ?? [])
      .filter(g => plexTagSet.has(g.toLowerCase()))
      .map(toPlexTag),
    apple:  itunesData?.genre && plexTagSet.has(itunesData.genre.toLowerCase())
      ? [toPlexTag(itunesData.genre)]
      : [],
  }
  const seenTagKeys = new Set<string>()
  const allTags: PlexTag[] = []
  for (const src of priority) {
    for (const entry of (tagsBySource[src] ?? [])) {
      const key = entry.tag.toLowerCase()
      if (!seenTagKeys.has(key)) { seenTagKeys.add(key); allTags.push(entry) }
    }
  }
  // Use Deezer label as fallback when Plex has none.
  // Deezer returns the literal string "[no label]" for unlabelled releases — filter that out.
  const deezerLabel = deezerData?.label && deezerData.label !== "[no label]" ? deezerData.label : null
  const displayLabel = album.label.length > 0
    ? album.label.map(l => l.tag).join(", ")
    : deezerLabel

  // Show all non-empty hubs (sonically similar, more by artist, etc.)
  const nonEmptyHubs = relatedHubs.filter(h => h.metadata.length > 0)
  const review = album.reviews.length > 0 ? album.reviews[0] : null

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="relative flex flex-row items-end p-8 overflow-hidden rounded-t-lg min-h-72 transition-[min-height] duration-500 hero-overlay">
        {/* UltraBlur background — album art first, artist art as fallback */}
        <UltraBlur src={thumbUrl ?? parentThumbUrl} />

        {/* Absolute-positioned action buttons — bottom-right, non-blocking */}
        <div className="absolute bottom-8 right-8 z-20 flex items-center gap-3">
          {/* Play */}
          <button
            onClick={() => tracks.length > 0 && void playTrack(tracks[0], tracks, album.title, `/album/${albumId}`)}
            disabled={tracks.length === 0}
            title="Play"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-accent hover:bg-black/45 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor">
              <polygon points="3,2 13,8 3,14" />
            </svg>
          </button>
          {/* Shuffle */}
          <button
            onClick={() => { if (tracks.length === 0) return; const s = [...tracks].sort(() => Math.random() - 0.5); void playTrack(s[0], s, album.title, `/album/${albumId}`) }}
            disabled={tracks.length === 0}
            title="Shuffle"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm border border-white/10 text-accent hover:bg-black/45 hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
              <path d="m7.5 10.723.98-1.167.957 1.14a2.25 2.25 0 0 0 1.724.804h1.947l-1.017-1.018a.75.75 0 1 1 1.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 1 1-1.06-1.06L13.109 13H11.16a3.75 3.75 0 0 1-2.873-1.34l-.787-.938z" />
            </svg>
          </button>
          {/* Album Radio */}
          <button
            onClick={() => void playRadio(albumId, 'album')}
            title="Album Radio — continuous sonically-similar music"
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
                <div className="absolute right-0 top-full mt-1 z-50 w-52 rounded-lg bg-app-surface shadow-xl border border-[var(--border)] py-1">
                  <button
                    onClick={() => { addToQueue(tracks); setMenuOpen(false) }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                      <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/>
                    </svg>
                    Add album to Queue
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="relative z-10 flex flex-row items-end w-full gap-6">
          {/* Album art — click to open modal */}
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt=""
              onClick={() => setShowImageModal(true)}
              className="w-52 h-52 rounded-md shadow-2xl object-cover flex-shrink-0 cursor-pointer ring-2 ring-transparent hover:ring-white/40 transition-all duration-200"
            />
          ) : (
            <div className="w-52 h-52 rounded-md bg-app-surface shadow-2xl flex-shrink-0" />
          )}

          {/* Info column — no fixed height so hero grows with expanded description */}
          <div className="flex min-w-0 flex-1 flex-col gap-2 pr-72 pb-2">
            <div className="text-xs font-semibold uppercase tracking-widest text-gray-300">{formatLabel}</div>
            <h1 className="text-4xl font-black text-white leading-tight select-text">{album.title}</h1>

            <div className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
              {parentThumbUrl && (
                <img src={parentThumbUrl} alt="" className="h-6 w-6 rounded-full object-cover flex-shrink-0" />
              )}
              <Link
                href={`/artist/${album.parent_key.split("/").pop()}`}
                className="font-semibold hover:underline"
              >
                {album.parent_title}
              </Link>
              <span className="text-gray-500">·</span>
              <span className="text-gray-400">{album.year}</span>
              <span className="text-gray-500">·</span>
              <span className="text-gray-400">{tracks.length} {tracks.length === 1 ? "song" : "songs"}</span>
              <span className="text-gray-500">·</span>
              <span className="text-gray-400">{formatTotalDuration(tracks)}</span>
              {album.studio && (
                <>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-400">{album.studio}</span>
                </>
              )}
              {displayLabel && (
                <>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-400">{displayLabel}</span>
                </>
              )}
              {deezerData && deezerData.fans > 0 && (
                <>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-400">{deezerData.fans.toLocaleString()} fans</span>
                </>
              )}
            </div>

            {/* Rating */}
            <HeroRating ratingKey={albumId} userRating={album.user_rating} />

            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {allTags.map(t => <TagChip key={t.tag} tag={t} tagType={tagTypeMap.get(t.tag.toLowerCase()) ?? "genre"} />)}
              </div>
            )}

            {/* Expandable description */}
            {displayWiki && (
              <div
                className="cursor-pointer select-text max-w-xl"
                onClick={() => setDescExpanded(v => !v)}
              >
                <div
                  className="overflow-hidden transition-all duration-500 ease-in-out"
                  style={{ maxHeight: descExpanded ? "500px" : "2.8rem" }}
                >
                  <p className="text-sm leading-relaxed text-gray-300">{displayWiki}</p>
                </div>
                <span className="mt-0.5 flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors">
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    fill="currentColor"
                    className={`transition-transform duration-300 ${descExpanded ? "rotate-180" : ""}`}
                  >
                    <path d="M8 10.94 2.53 5.47l1.06-1.06L8 8.82l4.41-4.41 1.06 1.06z" />
                  </svg>
                  {descExpanded ? "Less" : "More"}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Track list */}
      <div className="px-8">
        <table className="w-full text-sm text-gray-400">
          <thead className="border-b border-white/10">
            <tr>
              <th className="p-2 text-center w-8">#</th>
              <th className="p-2 text-left">Title</th>
              <th className="p-2 text-center w-36">Rating</th>
              <th className="p-2 text-right">Duration</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((track, idx) => {
              const isActive = currentTrack?.rating_key === track.rating_key
              return (
              <tr
                key={track.rating_key}
                className={`group cursor-pointer rounded ${isActive ? "bg-white/5" : "hover:bg-white/5"}`}
                onClick={() => void playTrack(track, tracks, album.title, `/album/${albumId}`)}
                onMouseEnter={() => prefetchTrackAudio(track)}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, "track", track) }}
              >
                <td className="p-2 text-center w-8">
                  {isActive ? (
                    <>
                      <span className="group-hover:hidden flex items-center justify-center text-accent">
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                          <rect x="1" y="3" width="3" height="10" rx="1"/><rect x="6" y="1" width="3" height="12" rx="1"/><rect x="11" y="5" width="3" height="8" rx="1"/>
                        </svg>
                      </span>
                      <span className="hidden group-hover:flex items-center justify-center text-accent">
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><polygon points="3,2 13,8 3,14" /></svg>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="group-hover:hidden">{track.index || idx + 1}</span>
                      <span className="hidden group-hover:flex items-center justify-center">
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                          <polygon points="3,2 13,8 3,14" />
                        </svg>
                      </span>
                    </>
                  )}
                </td>
                <td className="p-2">
                  <div className={isActive ? "text-accent" : "text-white"}>{track.title}</div>
                  {track.original_title && track.original_title !== album.parent_title && (
                    <div className="text-xs text-gray-500">{track.original_title}</div>
                  )}
                </td>
                <td className="p-2 text-center" onClick={e => e.stopPropagation()}>
                  <HeroRating ratingKey={track.rating_key} userRating={track.user_rating} />
                </td>
                <td className="p-2 text-right tabular-nums">
                  <span className="group-hover:hidden">{formatMs(track.duration)}</span>
                  <div className="hidden group-hover:inline-flex items-center gap-2">
                    <button
                      className="flex items-center gap-0.5 text-xs text-gray-400 hover:text-white transition-colors px-1"
                      title="Add to Queue"
                      onClick={e => { e.stopPropagation(); addToQueue([track]) }}
                    >
                      <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                        <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/>
                      </svg>
                      Queue
                    </button>
                    <button
                      className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors px-1"
                      title="Track Radio"
                      onClick={e => { e.stopPropagation(); void playRadio(track.rating_key, 'track') }}
                    >
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                      </svg>
                      Radio
                    </button>
                  </div>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Review */}
      {review && (
        <div className="px-8 pt-6">
          <div className="max-w-2xl rounded-lg border border-white/10 bg-white/5 p-4">
            {review.tag && (
              <div className="mb-2 text-sm font-semibold text-white">{review.tag}</div>
            )}
            {review.text && (
              <p className="text-sm leading-relaxed text-gray-400 line-clamp-4">{review.text}</p>
            )}
            {review.source && (
              <div className="mt-2 text-xs text-gray-500">— {review.source}</div>
            )}
          </div>
        </div>
      )}

      {/* Related hubs (sonically similar, more by artist, etc.) */}
      {nonEmptyHubs.length > 0 && (
        <div className="flex flex-col gap-8 px-8 pt-10">
          {nonEmptyHubs.map(hub => {
            const albumItems = hub.metadata.filter(
              (m): m is Album & { type: "album" } => m.type === "album"
            )
            const artistItems = hub.metadata.filter(
              (m): m is Artist & { type: "artist" } => m.type === "artist"
            )

            if (albumItems.length > 0) {
              return (
                <ScrollRow key={hub.hub_identifier} title={hub.title} restoreKey={`album-${albumId}-${hub.hub_identifier}`}>
                  {albumItems.map(a => (
                    <MediaCard
                      key={a.rating_key}
                      title={a.title}
                      desc={`${a.parent_title} · ${a.year}`}
                      thumb={a.thumb ? buildPlexImageUrl(baseUrl, token, a.thumb) : null}
                      href={`/album/${a.rating_key}`}
                      prefetch={() => prefetchAlbum(a.rating_key)}
                      scrollItem
                    />
                  ))}
                </ScrollRow>
              )
            }

            if (artistItems.length > 0) {
              return (
                <ScrollRow key={hub.hub_identifier} title={hub.title} restoreKey={`album-${albumId}-${hub.hub_identifier}`}>
                  {artistItems.map(a => (
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
              )
            }

            return null
          })}
        </div>
      )}

      {/* Album art modal */}
      {showImageModal && thumbUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setShowImageModal(false)}
        >
          <img
            src={thumbUrl}
            alt={album.title}
            className="max-h-[85vh] max-w-[85vw] rounded-2xl shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
