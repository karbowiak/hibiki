import { ArtworkImage } from "../shared/ArtworkImage"
import { useEffect, useMemo, useState } from "react"
import { Link, useLocation } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore, usePlayerStore } from "../../stores"
import { useProviderStore } from "../../stores/providerStore"
import { useCapability } from "../../hooks/useCapability"
import { formatTotalMs } from "../../lib/formatters"
import { UltraBlur } from "../UltraBlur"
import { useTableSort } from "../../hooks/useTableSort"
import { ALL_COLUMNS, usePlaylistColumns } from "../../hooks/useColumnPicker"
import { TrackTable } from "../shared/TrackTable"
import type { MusicTrack, MusicPlaylist } from "../../types/music"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function mixTitleToArtistName(title: string): string {
  return title.replace(/\s+(Mix|Radio|Station|Mix Radio)$/i, "").trim()
}

function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffleTracks(arr: MusicTrack[], title: string): MusicTrack[] {
  const result = [...arr]
  const rng = mulberry32(hashString(title))
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

const mixThumbCache = new Map<string, string>()

// ---------------------------------------------------------------------------
// Module-level state: the mix item selected on the homepage.
// Plex hub mixes have rating_key=0 — we cannot route by ID, so Home.tsx
// calls selectMix() before navigating to /mix.
// ---------------------------------------------------------------------------

let _selectedMix: MusicPlaylist | null = null

export function selectMix(item: MusicPlaylist) {
  _selectedMix = item
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MixPage() {
  const [, navigate] = useLocation()
  const hasMixTracks = useCapability("mixTracks")
  const [mixItem] = useState<MusicPlaylist | null>(() => _selectedMix)
  const provider = useProviderStore(s => s.provider)

  const { playTrack, playRadio, addToQueue, currentTrack } = usePlayerStore(
    useShallow(s => ({
      playTrack: s.playTrack,
      playRadio: s.playRadio,
      addToQueue: s.addToQueue,
      currentTrack: s.currentTrack,
    }))
  )

  const { visible: visibleCols, toggle: toggleCol } = usePlaylistColumns("plex-mix-columns", ["album" as const])

  const [filterQuery, setFilterQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(filterQuery), 150)
    return () => clearTimeout(t)
  }, [filterQuery])

  type SortCol = "default" | "title" | "artist" | "album" | "year" | "plays" | "popularity" | "label" | "bitrate" | "format" | "added_at" | "rating" | "rated_at" | "duration"
  const { sortCol, sortDir, handleSort } = useTableSort<SortCol>()

  if (!hasMixTracks) { navigate("/"); return null }

  const mixKey = mixItem?.providerKey as string | undefined

  const [tracks, setTracks] = useState<MusicTrack[]>(() => {
    if (!mixKey) return []
    // Shuffle on mount so the displayed list is randomised immediately.
    return shuffleTracks(useLibraryStore.getState().mixTracksCache[mixKey] ?? [], mixItem?.title ?? mixKey)
  })
  const [isLoading, setIsLoading] = useState(() => {
    if (!mixKey) return false
    const cached = useLibraryStore.getState().mixTracksCache[mixKey]
    return !cached || cached.length === 0
  })
  const [artistThumb, setArtistThumb] = useState<string | null>(
    () => mixItem ? (mixThumbCache.get(mixItem.title) ?? null) : null
  )

  // Unique artists derived from the loaded track list, preserving first-seen order.
  const artists = useMemo(() => {
    const seen = new Set<string>()
    const result: { title: string; id: string | null }[] = []
    for (const t of tracks) {
      if (t.artistName && !seen.has(t.artistName)) {
        seen.add(t.artistName)
        result.push({ title: t.artistName, id: t.artistId })
      }
    }
    return result
  }, [tracks])

  // Fetch the track list for this mix (skipped if already pre-cached).
  // Cache hits are already shuffled and set via the useState initializer above.
  useEffect(() => {
    if (!mixKey || !provider) return
    const cached = useLibraryStore.getState().mixTracksCache[mixKey]
    if (cached && cached.length > 0) {
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    const fetch = provider.getMixTracks?.(mixKey)
    if (!fetch) { setIsLoading(false); return }
    fetch
      .then(t => setTracks(shuffleTracks(t, mixItem?.title ?? mixKey)))
      .catch(() => setTracks([]))
      .finally(() => setIsLoading(false))
  }, [mixKey, provider])

  // Look up the artist thumbnail (e.g. "Ado Mix" → search for "Ado").
  useEffect(() => {
    if (!mixItem || !provider) return
    const cached = mixThumbCache.get(mixItem.title)
    if (cached) { setArtistThumb(cached); return }
    const artistName = mixTitleToArtistName(mixItem.title)
    if (!artistName) return
    provider.search(artistName, "artist")
      .then(results => {
        const artist =
          results.find(r => r.type === "artist" && r.title.toLowerCase() === artistName.toLowerCase()) ??
          results.find(r => r.type === "artist")
        if (artist && artist.type === "artist" && artist.thumbUrl) {
          mixThumbCache.set(mixItem.title, artist.thumbUrl)
          setArtistThumb(artist.thumbUrl)
        }
      })
      .catch(() => {})
  }, [mixItem?.title, provider])

  const filteredTracks = useMemo(() => {
    if (!debouncedQuery) return tracks
    const q = debouncedQuery.toLowerCase()
    return tracks.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.artistName.toLowerCase().includes(q) ||
      t.albumName.toLowerCase().includes(q)
    )
  }, [tracks, debouncedQuery])

  const sortedTracks = useMemo(() => {
    if (sortCol === "default") return filteredTracks
    const items = [...filteredTracks]
    items.sort((a, b) => {
      let cmp = 0
      switch (sortCol) {
        case "title":      cmp = a.title.localeCompare(b.title); break
        case "artist":     cmp = a.artistName.localeCompare(b.artistName); break
        case "album":      cmp = a.albumName.localeCompare(b.albumName); break
        case "year":       cmp = (a.albumYear ?? a.year) - (b.albumYear ?? b.year); break
        case "plays":      cmp = a.playCount - b.playCount; break
        case "popularity": cmp = (a.ratingCount ?? 0) - (b.ratingCount ?? 0); break
        case "label":      cmp = (a.parentStudio ?? "").localeCompare(b.parentStudio ?? ""); break
        case "bitrate":    cmp = (a.bitrate ?? 0) - (b.bitrate ?? 0); break
        case "format":     cmp = (a.codec ?? "").localeCompare(b.codec ?? ""); break
        case "added_at":   cmp = (a.addedAt ? +new Date(a.addedAt) : 0) - (b.addedAt ? +new Date(b.addedAt) : 0); break
        case "rating":     cmp = (a.userRating ?? 0) - (b.userRating ?? 0); break
        case "rated_at": {
          cmp = (a.lastRatedAt ? +new Date(a.lastRatedAt) : 0) - (b.lastRatedAt ? +new Date(b.lastRatedAt) : 0)
          break
        }
        case "duration":   cmp = a.duration - b.duration; break
      }
      return sortDir === "asc" ? cmp : -cmp
    })
    return items
  }, [filteredTracks, sortCol, sortDir])

  if (!mixItem) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <h1 className="mb-2 text-xl font-bold">No mix selected</h1>
        <p className="text-sm text-white/50">Navigate to a mix from the home page.</p>
      </div>
    )
  }

  const displayThumb = artistThumb ?? mixItem.thumbUrl
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

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="relative flex flex-row items-end p-8 overflow-hidden rounded-t-lg hero-overlay">
        <UltraBlur src={displayThumb} />
        <div className="relative z-10 flex flex-row items-end w-full gap-0">
          {/* Cover art */}
          {displayThumb ? (
            <ArtworkImage loading="eager" src={displayThumb} alt="" className="w-60 h-60 rounded-md shadow-2xl object-cover flex-shrink-0" />
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

              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Track list */}
      <TrackTable
        tracks={sortedTracks}
        visibleCols={visibleCols}
        toggleCol={toggleCol}
        sortCol={sortCol}
        sortDir={sortDir}
        onSort={handleSort}
        onPlay={(track, all) => void playTrack(track, all, mixItem.title, "/mix")}
        onAddToQueue={addToQueue}
        onPlayRadio={playRadio}
        columns={ALL_COLUMNS}
        searchPlaceholder="Search in mix…  ⌘K"
        filterQuery={filterQuery}
        onFilterChange={setFilterQuery}
        defaultResetTitle="Restore shuffled order"
        isLoading={isLoading}
        loadedCount={tracks.length}
        emptyMessage="No tracks found for this mix."
        currentTrackId={currentTrack?.id ?? null}
      />
    </div>
  )
}
