import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useLocation } from "wouter"
import { open } from "@tauri-apps/plugin-shell"
import { useShallow } from "zustand/react/shallow"
import { useContextMenuStore } from "../stores/contextMenuStore"
import { usePlayerStore, useLibraryStore } from "../stores"
import { useConnectionStore } from "../stores/connectionStore"
import { useLastfmStore } from "../stores/lastfmStore"
import { useDeezerMetadataStore } from "../stores/deezerMetadataStore"
import { useUIStore } from "../stores/uiStore"
import { rateItem, addItemsToPlaylist, getAlbumTracks, buildItemUri } from "../lib/plex"
import { lastfmLoveTrack } from "../lib/lastfm"
import { getRecentPlaylistIds, recordRecentPlaylist } from "../lib/recentPlaylists"
import type { Track, Album, Artist, Playlist } from "../types/plex"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractId(key: string): number {
  return parseInt(key.split("/").pop() ?? "0", 10)
}

function lfmUrl(type: "artist" | "album" | "track", artist: string, albumOrTrack?: string): string {
  const a = encodeURIComponent(artist)
  if (type === "artist") return `https://www.last.fm/music/${a}`
  if (type === "album") return `https://www.last.fm/music/${a}/${encodeURIComponent(albumOrTrack ?? "")}`
  return `https://www.last.fm/music/${a}/_/${encodeURIComponent(albumOrTrack ?? "")}`
}

// ---------------------------------------------------------------------------
// Inline star rating
// ---------------------------------------------------------------------------

interface StarsProps {
  ratingKey: number
  userRating: number | null
  isTrack: boolean
  artistName: string
  trackTitle: string
  onDone: () => void
}

function InlineStars({ ratingKey, userRating, isTrack, artistName, trackTitle, onDone }: StarsProps) {
  const loveThreshold = useLastfmStore(s => s.loveThreshold)
  const [local, setLocal] = useState<number | null | undefined>(undefined)
  const display = local !== undefined ? local : userRating
  const filled = Math.round((display ?? 0) / 2)

  function rate(star: number) {
    const value = filled === star ? null : star * 2
    setLocal(value)
    void rateItem(ratingKey, value).catch(() => setLocal(undefined))
    if (isTrack && artistName && trackTitle) {
      void lastfmLoveTrack(artistName, trackTitle, (value ?? 0) >= loveThreshold).catch(() => {})
    }
    onDone()
  }

  return (
    <div className="flex items-center gap-1 px-3 py-2" onClick={e => e.stopPropagation()}>
      <span className="text-xs text-white/40 mr-1 w-10">Rating</span>
      {[1, 2, 3, 4, 5].map(star => (
        <button
          key={star}
          title={`${star} star${star > 1 ? "s" : ""}`}
          onClick={e => { e.stopPropagation(); rate(star) }}
          className={`transition-colors ${filled >= star ? "text-accent" : "text-white/30 hover:text-accent/70"}`}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z" />
          </svg>
        </button>
      ))}
      {filled > 0 && (
        <button
          title="Clear rating"
          onClick={e => { e.stopPropagation(); rate(filled) }}
          className="ml-1 text-white/25 hover:text-white/60 text-xs"
        >✕</button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Menu item primitives
// ---------------------------------------------------------------------------

function Item({ icon, label, onClick, danger }: { icon?: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors hover:bg-white/8 ${danger ? "text-red-400" : "text-white/85"}`}
    >
      {icon && <span className="w-4 h-4 flex-shrink-0 opacity-70">{icon}</span>}
      {label}
    </button>
  )
}

function Divider() {
  return <div className="my-1 border-t border-white/8" />
}

function SectionLabel({ label }: { label: string }) {
  return <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/30">{label}</div>
}

// ---------------------------------------------------------------------------
// SVG icons
// ---------------------------------------------------------------------------

const IconPlay = <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><polygon points="3,2 13,8 3,14" /></svg>
const IconNext = <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 18l8.5-6L6 6v12zm2-8.14L11.03 12 8 14.14V9.86zM16 6h2v12h-2z" /></svg>
const IconQueue = <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" /></svg>
const IconNewPlaylist = <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm11.5-4.5v3h-3v2h3v3h2v-3h3v-2h-3v-3h-2z" /></svg>
const IconRadio = <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20 10.54V5l-7.56 2.84-5.16 1.94L5 10H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2v-7.46l-3-2zm1 9.46H3v-8h18v8zM9 14.5c0 1.38-1.12 2.5-2.5 2.5S4 15.88 4 14.5 5.12 12 6.5 12 9 13.12 9 14.5z" /></svg>
const IconShare = <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" /></svg>
const IconArtist = <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5.33 0-8 2.67-8 4v1h16v-1c0-1.33-2.67-4-8-4z" /></svg>
const IconAlbum = <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z" /></svg>
const IconPlaylist = <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM3 16h7v-2H3v2z" /></svg>

// ---------------------------------------------------------------------------
// Playlist section
// ---------------------------------------------------------------------------

interface PlaylistSectionProps {
  itemIds: number[]
  close: () => void
  onNewPlaylist: () => void
}

function PlaylistSection({ itemIds, close, onNewPlaylist }: PlaylistSectionProps) {
  const playlists = useLibraryStore(s => s.playlists).filter(p => !p.smart && !p.radio)
  const recentIds = getRecentPlaylistIds()

  const recentPlaylists = recentIds
    .map(id => playlists.find(p => p.rating_key === id))
    .filter((p): p is Playlist => p !== undefined)

  const otherPlaylists = playlists
    .filter(p => !recentIds.includes(p.rating_key))
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))

  async function addTo(playlist: Playlist) {
    recordRecentPlaylist(playlist.rating_key)
    await addItemsToPlaylist(playlist.rating_key, itemIds).catch(() => {})
    close()
  }

  return (
    <div className="max-h-52 overflow-y-auto">
      <Item icon={IconNewPlaylist} label="New playlist…" onClick={onNewPlaylist} />
      {recentPlaylists.length > 0 && (
        <>
          <Divider />
          <SectionLabel label="Recent" />
          {recentPlaylists.map(pl => (
            <Item key={pl.rating_key} icon={IconPlaylist} label={pl.title} onClick={() => void addTo(pl)} />
          ))}
          {otherPlaylists.length > 0 && <Divider />}
        </>
      )}
      {otherPlaylists.length > 0 && recentPlaylists.length === 0 && <Divider />}
      {otherPlaylists.map(pl => (
        <Item key={pl.rating_key} icon={IconPlaylist} label={pl.title} onClick={() => void addTo(pl)} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ContextMenu() {
  const { open: isOpen, x, y, type, data, close } = useContextMenuStore()
  const { playTrack, playFromUri, playRadio, addNext, addToQueue } = usePlayerStore(useShallow(s => ({
    playTrack: s.playTrack,
    playFromUri: s.playFromUri,
    playRadio: s.playRadio,
    addNext: s.addNext,
    addToQueue: s.addToQueue,
  })))
  const { sectionUuid } = useConnectionStore(useShallow(s => ({ sectionUuid: s.sectionUuid })))
  const { setShowCreatePlaylist, setPendingPlaylistItemIds } = useUIStore(useShallow(s => ({
    setShowCreatePlaylist: s.setShowCreatePlaylist,
    setPendingPlaylistItemIds: s.setPendingPlaylistItemIds,
  })))
  const [, navigate] = useLocation()
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState({ left: -9999, top: -9999 })

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") close() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [isOpen, close])

  // Clamp to viewport after actual render so we know the real menu height.
  // When closed, reset to off-screen so there's no flash at the old position on next open.
  useLayoutEffect(() => {
    if (!isOpen) {
      setMenuPos({ left: -9999, top: -9999 })
      return
    }
    if (!menuRef.current) return
    const el = menuRef.current
    const rect = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    setMenuPos({ left, top })
  }, [isOpen, x, y])

  if (!isOpen || !type || !data) return null

  const track = type === "track" ? (data as Track) : null
  const album = type === "album" ? (data as Album) : null
  const artist = type === "artist" ? (data as Artist) : null

  // Deezer URLs (synchronous cache read)
  const deezerState = useDeezerMetadataStore.getState()
  let deezerUrl: string | null = null
  if (artist) {
    const cached = deezerState.artists[artist.title.toLowerCase()]
    deezerUrl = cached?.data.deezer_url ?? null
  } else if (album) {
    const key = `${album.parent_title.toLowerCase()}::${album.title.toLowerCase()}`
    const cached = deezerState.albums[key]
    deezerUrl = cached?.data.deezer_url ?? null
  } else if (track) {
    const key = `${(track.grandparent_title ?? "").toLowerCase()}::${(track.parent_title ?? "").toLowerCase()}`
    const cached = deezerState.albums[key]
    deezerUrl = cached?.data.deezer_url ?? null
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  function doPlay() {
    if (track) void playTrack(track)
    else if (album) {
      const uri = buildItemUri(sectionUuid, album.key)
      void playFromUri(uri, false, album.title, `/album/${album.rating_key}`)
    } else if (artist) {
      const uri = buildItemUri(sectionUuid, artist.key)
      void playFromUri(uri, false, artist.title, `/artist/${artist.rating_key}`)
    }
    close()
  }

  function doAddNext() {
    if (track) {
      addNext([track])
      close()
    } else if (album) {
      void getAlbumTracks(album.rating_key).then(tracks => { addNext(tracks); close() })
    }
  }

  function doQueue() {
    if (track) {
      addToQueue([track])
      close()
    } else if (album) {
      void getAlbumTracks(album.rating_key).then(tracks => {
        addToQueue(tracks)
        close()
      })
    } else if (artist) {
      // For artists, play from URI in shuffle mode which enqueues all tracks
      const uri = buildItemUri(sectionUuid, artist.key)
      void playFromUri(uri, true, artist.title, `/artist/${artist.rating_key}`)
      close()
    }
  }

  function doRadio() {
    const key = track?.rating_key ?? album?.rating_key ?? artist?.rating_key
    const radioType = track ? "track" : album ? "album" : "artist"
    if (key) void playRadio(key, radioType as "track" | "album" | "artist")
    close()
  }

  function doShare(url: string) {
    void open(url)
    close()
  }

  function goToArtist() {
    if (track) navigate(`/artist/${extractId(track.grandparent_key)}`)
    close()
  }

  function goToAlbum() {
    if (track) navigate(`/album/${extractId(track.parent_key)}`)
    close()
  }

  // Determine item IDs for "add to playlist"
  const itemIds = track
    ? [track.rating_key]
    : album
    ? [album.rating_key]
    : artist
    ? [artist.rating_key]
    : []

  // Rating data
  const ratingKey = data.rating_key
  const userRating = data.user_rating ?? null
  const artistName = track?.grandparent_title ?? album?.parent_title ?? artist?.title ?? ""
  const itemTitle = track?.title ?? album?.title ?? artist?.title ?? ""

  // Share URLs
  const lfmArtistUrl = lfmUrl("artist", artistName)
  const lfmItemUrl = track
    ? lfmUrl("track", artistName, itemTitle)
    : album
    ? lfmUrl("album", artistName, itemTitle)
    : null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[9998]" onContextMenu={e => { e.preventDefault(); close() }} onClick={close} />

      {/* Menu */}
      <div
        ref={menuRef}
        style={{ left: menuPos.left, top: menuPos.top }}
        className="fixed z-[9999] w-60 rounded-lg border border-white/10 bg-[#1a1a1f] shadow-2xl py-1 text-sm select-none"
      >
        {/* Play */}
        <Item
          icon={IconPlay}
          label={type === "track" ? "Play now" : type === "album" ? "Play album" : "Play all"}
          onClick={doPlay}
        />
        {(track || album) && <Item icon={IconNext} label="Play next" onClick={doAddNext} />}
        <Item icon={IconQueue} label="Add to bottom" onClick={doQueue} />
        <Item icon={IconRadio} label="Start radio" onClick={doRadio} />

        <Divider />

        {/* Rating */}
        <InlineStars
          ratingKey={ratingKey}
          userRating={userRating}
          isTrack={type === "track"}
          artistName={artistName}
          trackTitle={itemTitle}
          onDone={close}
        />

        {/* Add to playlist — tracks only */}
        {track && (
          <>
            <Divider />
            <SectionLabel label="Add to playlist" />
            <PlaylistSection
              itemIds={itemIds}
              close={close}
              onNewPlaylist={() => {
                setPendingPlaylistItemIds(itemIds)
                setShowCreatePlaylist(true)
                close()
              }}
            />
          </>
        )}

        <Divider />

        {/* Share */}
        <SectionLabel label="Share" />
        <Item icon={IconShare} label="Last.fm artist" onClick={() => doShare(lfmArtistUrl)} />
        {lfmItemUrl && (
          <Item
            icon={IconShare}
            label={type === "track" ? "Last.fm track" : "Last.fm album"}
            onClick={() => doShare(lfmItemUrl)}
          />
        )}
        {deezerUrl && (
          <Item icon={IconShare} label="Deezer" onClick={() => doShare(deezerUrl!)} />
        )}

        {/* Navigation */}
        {track && (
          <>
            <Divider />
            <Item icon={IconArtist} label="Go to artist" onClick={goToArtist} />
            <Item icon={IconAlbum} label="Go to album" onClick={goToAlbum} />
          </>
        )}
        {album && (
          <>
            <Divider />
            <Item
              icon={IconArtist}
              label="Go to artist"
              onClick={() => { navigate(`/artist/${extractId(album.parent_key)}`); close() }}
            />
          </>
        )}
      </div>
    </>
  )
}
