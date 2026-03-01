import { useEffect, useState } from "react"
import { Link } from "wouter"
import { useConnectionStore, usePlayerStore, buildPlexImageUrl, useUIStore } from "../../stores"
import { getAlbum, getAlbumTracks, getRelatedHubs } from "../../lib/plex"
import type { Album, Artist, Track, Hub, PlexTag } from "../../types/plex"
import { MediaCard } from "../MediaCard"
import { ScrollRow } from "../ScrollRow"
import { UltraBlur } from "../UltraBlur"
import { getCachedAlbum, prefetchAlbum, prefetchArtist, setAlbumCache } from "../../stores/metadataCache"

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

function TagChip({ tag }: { tag: PlexTag }) {
  return (
    <span className="rounded-full border border-white/20 px-2.5 py-0.5 text-xs text-gray-300">
      {tag.tag}
    </span>
  )
}

export function AlbumPage({ albumId }: { albumId: number }) {
  const { baseUrl, token, musicSectionId } = useConnectionStore()
  const { playTrack } = usePlayerStore()
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

  if (isLoading) return <div className="p-8 text-sm text-gray-400">Loading album…</div>
  if (error) return <div className="p-8 text-sm text-red-400">{error}</div>
  if (!album) return null

  const thumbUrl = album.thumb ? buildPlexImageUrl(baseUrl, token, album.thumb) : null
  const parentThumbUrl = album.parent_thumb
    ? buildPlexImageUrl(baseUrl, token, album.parent_thumb)
    : null

  const formatLabel = album.subformat.length > 0
    ? album.subformat.map(f => f.tag).join(" · ")
    : "Album"

  const allTags = [
    ...album.genre,
    ...album.style,
    ...album.mood,
  ]

  // Show all non-empty hubs (sonically similar, more by artist, etc.)
  const nonEmptyHubs = relatedHubs.filter(h => h.metadata.length > 0)
  const review = album.reviews.length > 0 ? album.reviews[0] : null

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="relative flex flex-row items-end p-8 overflow-hidden rounded-t-lg min-h-72 transition-[min-height] duration-500">
        {/* UltraBlur background — album art first, artist art as fallback */}
        <UltraBlur src={thumbUrl ?? parentThumbUrl} />

        {/* Absolute-positioned action buttons — bottom-right, non-blocking */}
        <div className="absolute bottom-8 right-8 z-10 flex items-center gap-3">
          <button
            onClick={() => tracks.length > 0 && void playTrack(tracks[0], tracks)}
            disabled={tracks.length === 0}
            title="Play"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-[#1db954] text-black shadow-lg hover:bg-[#1ed760] hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor">
              <polygon points="3,2 13,8 3,14" />
            </svg>
          </button>
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
            <div className="w-52 h-52 rounded-md bg-[#282828] shadow-2xl flex-shrink-0" />
          )}

          {/* Info column — no fixed height so hero grows with expanded description */}
          <div className="flex min-w-0 flex-1 flex-col gap-2 pr-20 pb-2">
            <div className="text-xs font-semibold uppercase tracking-widest text-gray-300">{formatLabel}</div>
            <h1 className="text-4xl font-black text-white leading-tight truncate">{album.title}</h1>

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
              {album.label.length > 0 && (
                <>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-400">{album.label.map(l => l.tag).join(", ")}</span>
                </>
              )}
            </div>

            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {allTags.map(t => <TagChip key={t.tag} tag={t} />)}
              </div>
            )}

            {/* Expandable description */}
            {album.summary && (
              <div
                className="cursor-pointer select-none max-w-xl"
                onClick={() => setDescExpanded(v => !v)}
              >
                <div
                  className="overflow-hidden transition-all duration-500 ease-in-out"
                  style={{ maxHeight: descExpanded ? "500px" : "2.8rem" }}
                >
                  <p className="text-sm leading-relaxed text-gray-300">{album.summary}</p>
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
              <th className="p-2 text-right">Duration</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((track, idx) => (
              <tr
                key={track.rating_key}
                className="group cursor-pointer hover:bg-white/5 rounded"
                onClick={() => void playTrack(track, tracks)}
              >
                <td className="p-2 text-center w-8">
                  <span className="group-hover:hidden">{track.index || idx + 1}</span>
                  <span className="hidden group-hover:flex items-center justify-center">
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                      <polygon points="3,2 13,8 3,14" />
                    </svg>
                  </span>
                </td>
                <td className="p-2">
                  <div className="text-white">{track.title}</div>
                  {track.original_title && (
                    <div className="text-xs text-gray-500">{track.original_title}</div>
                  )}
                </td>
                <td className="p-2 text-right tabular-nums">{formatMs(track.duration)}</td>
              </tr>
            ))}
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
