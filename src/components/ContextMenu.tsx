import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useLocation } from "wouter"
import { open } from "@tauri-apps/plugin-shell"
import { useShallow } from "zustand/react/shallow"
import { useContextMenuStore } from "../stores/contextMenuStore"
import { usePlayerStore, useLibraryStore } from "../stores"
import { useDeezerMetadataStore } from "../metadata/deezer/store"
import { useUIStore } from "../stores/uiStore"
import { useDebugStore } from "../stores/debugStore"
import { useDebugPanelStore } from "../stores/debugPanelStore"
import { useProviderStore } from "../stores/providerStore"
import { useProviderMutationOwner } from "../hooks/useProviderMutationOwner"
import { useCapability } from "../hooks/useCapability"
import { StarRating } from "./shared/StarRating"
import {
  MenuItem as Item, MenuDivider as Divider, MenuSectionLabel as SectionLabel,
  IconPlay, IconNext, IconQueue, IconNewPlaylist, IconRadio, IconShare,
  IconArtist, IconAlbum, IconPlaylist, IconBug, IconShuffle, IconEdit, IconDelete, IconRemove,
} from "./shared/ContextMenuPrimitives"
import { getRecentPlaylistIds, recordRecentPlaylist } from "../lib/recentPlaylists"
import type { MusicTrack, MusicAlbum, MusicArtist, MusicPlaylist } from "../types/music"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function lfmUrl(type: "artist" | "album" | "track", artist: string, albumOrTrack?: string): string {
  const a = encodeURIComponent(artist)
  if (type === "artist") return `https://www.last.fm/music/${a}`
  if (type === "album") return `https://www.last.fm/music/${a}/${encodeURIComponent(albumOrTrack ?? "")}`
  return `https://www.last.fm/music/${a}/_/${encodeURIComponent(albumOrTrack ?? "")}`
}

// ---------------------------------------------------------------------------
// Playlist section
// ---------------------------------------------------------------------------

interface PlaylistSectionProps {
  itemIds: string[]
  close: () => void
  onNewPlaylist: () => void
}

function PlaylistSection({ itemIds, close, onNewPlaylist }: PlaylistSectionProps) {
  const playlists = useLibraryStore(s => s.playlists).filter(p => !p.smart)
  const provider = useProviderStore(s => s.provider)
  const captureOwner = useProviderMutationOwner(provider)
  const recentIds = getRecentPlaylistIds()

  const recentPlaylists = recentIds
    .map(id => playlists.find(p => p.id === id))
    .filter((p): p is MusicPlaylist => p !== undefined)

  const otherPlaylists = playlists
    .filter(p => !recentIds.includes(p.id))

  async function addTo(playlist: MusicPlaylist) {
    const current = captureOwner(), generation = useContextMenuStore.getState().generation
    if (!provider || !current()) return
    try { await provider.addToPlaylist(playlist.id, itemIds) } catch {
      if (current() && useContextMenuStore.getState().generation === generation) useLibraryStore.setState({ error: "Unable to update the playlist. Please try again." })
      return
    }
    if (!current()) return
    recordRecentPlaylist(playlist.id, provider)
    useLibraryStore.getState().invalidatePlaylistItems(playlist.id)
    if (useContextMenuStore.getState().open && useContextMenuStore.getState().generation === generation) close()
  }

  return (
    <div className="max-h-52 overflow-y-auto">
      <Item icon={IconNewPlaylist} label="New playlist…" onClick={onNewPlaylist} />
      {recentPlaylists.length > 0 && (
        <>
          <Divider />
          <SectionLabel label="Recent" />
          {recentPlaylists.map(pl => (
            <Item key={pl.id} icon={IconPlaylist} label={pl.title} onClick={() => void addTo(pl)} />
          ))}
          {otherPlaylists.length > 0 && <Divider />}
        </>
      )}
      {otherPlaylists.length > 0 && recentPlaylists.length === 0 && <Divider />}
      {otherPlaylists.map(pl => (
        <Item key={pl.id} icon={IconPlaylist} label={pl.title} onClick={() => void addTo(pl)} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline rename input (replaces window.prompt to avoid audio stopping)
// ---------------------------------------------------------------------------

function InlineRenameInput({ initialValue, onConfirm, onCancel }: {
  initialValue: string
  onConfirm: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Auto-focus and select all text
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function handleSubmit() {
    const trimmed = value.trim()
    if (trimmed && trimmed !== initialValue) {
      onConfirm(trimmed)
    } else {
      onCancel()
    }
  }

  return (
    <div className="px-3 py-1.5">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") handleSubmit()
          if (e.key === "Escape") onCancel()
          e.stopPropagation()
        }}
        onBlur={handleSubmit}
        className="w-full rounded bg-white/10 border border-white/20 px-2 py-1 text-sm text-white focus:outline-none focus:border-accent/50"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline delete confirm (replaces window.confirm to avoid audio stopping)
// ---------------------------------------------------------------------------

function InlineDeleteConfirm({ title, onConfirm, onCancel }: {
  title: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="px-3 py-2">
      <p className="text-xs text-white/70 mb-2">Delete "{title}"?</p>
      <div className="flex gap-2">
        <button
          onClick={onConfirm}
          className="flex-1 rounded bg-red-600/80 px-2 py-1 text-xs text-white hover:bg-red-600 transition-colors"
        >
          Delete
        </button>
        <button
          onClick={onCancel}
          className="flex-1 rounded bg-white/10 px-2 py-1 text-xs text-white/70 hover:bg-white/20 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ContextMenu() {
  const { open: isOpen, x, y, type, data, playlistId: ctxPlaylistId, ownerProvider, generation, close } = useContextMenuStore()
  const debugEnabled = useDebugStore(s => s.debugEnabled)
  const showDebugPanel = useDebugPanelStore(s => s.show)
  const provider = useProviderStore(s => s.provider)
  const captureOwner = useProviderMutationOwner(provider)
  const hasRadio = useCapability("radio")
  const hasRatings = useCapability("ratings")
  const { playTrack, playFromUri, playRadio, addNext, addToQueue } = usePlayerStore(useShallow(s => ({
    playTrack: s.playTrack,
    playFromUri: s.playFromUri,
    playRadio: s.playRadio,
    addNext: s.addNext,
    addToQueue: s.addToQueue,
  })))
  const { setShowCreatePlaylist, setPendingPlaylistItemIds } = useUIStore(useShallow(s => ({
    setShowCreatePlaylist: s.setShowCreatePlaylist,
    setPendingPlaylistItemIds: s.setPendingPlaylistItemIds,
  })))
  const [, navigate] = useLocation()
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState({ left: -9999, top: -9999 })
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)

  // Reset inline states when menu reopens
  useEffect(() => {
    if (isOpen) {
      setRenaming(false)
      setConfirming(false)
    }
  }, [isOpen, generation])

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
  }, [isOpen, x, y, renaming, confirming, generation])

  if (!isOpen || !type || !data || ownerProvider !== provider) return null

  const currentMenu = () => useContextMenuStore.getState().open && useContextMenuStore.getState().generation === generation
  const failed = (current: () => boolean) => { if (current() && useContextMenuStore.getState().generation === generation) useLibraryStore.setState({ error: "Unable to update the playlist. Please try again." }) }

  const playlist = type === "playlist" ? (data as MusicPlaylist) : null
  const track = type === "track" ? (data as MusicTrack) : null
  const album = type === "album" ? (data as MusicAlbum) : null
  const artist = type === "artist" ? (data as MusicArtist) : null

  // Deezer URLs (synchronous cache read)
  const deezerState = useDeezerMetadataStore.getState()
  let deezerUrl: string | null = null
  if (artist) {
    const cached = deezerState.artists[artist.title.toLowerCase()]
    deezerUrl = cached?.data?.deezer_url ?? null
  } else if (album) {
    const key = `${album.artistName.toLowerCase()}::${album.title.toLowerCase()}`
    const cached = deezerState.albums[key]
    deezerUrl = cached?.data?.deezer_url ?? null
  } else if (track) {
    const key = `${(track.artistName ?? "").toLowerCase()}::${(track.albumName ?? "").toLowerCase()}`
    const cached = deezerState.albums[key]
    deezerUrl = cached?.data?.deezer_url ?? null
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  function doPlay() {
    if (track) void playTrack(track)
    else if (album && provider?.buildItemUri) {
      const uri = provider.buildItemUri(album.providerKey ?? `/library/metadata/${album.id}`)
      void playFromUri(uri, false, album.title, `/album/${album.id}`, album.id)
    } else if (artist && provider?.buildItemUri) {
      const uri = provider.buildItemUri(artist.providerKey ?? `/library/metadata/${artist.id}`)
      void playFromUri(uri, false, artist.title, `/artist/${artist.id}`)
    }
    close()
  }

  function doAddNext() {
    if (track) {
      addNext([track])
      close()
    } else if (album && provider) {
      const current = captureOwner()
      void provider.getAlbumTracks(album.id).then(tracks => { if (current() && currentMenu()) { addNext(tracks); close() } }).catch(() => failed(() => current() && currentMenu()))
    }
  }

  function doQueue() {
    if (track) {
      addToQueue([track])
      close()
    } else if (album && provider) {
      const current = captureOwner()
      void provider.getAlbumTracks(album.id).then(tracks => {
        if (!current() || !currentMenu()) return
        addToQueue(tracks)
        close()
      }).catch(() => failed(() => current() && currentMenu()))
    } else if (artist && provider?.buildItemUri) {
      const uri = provider.buildItemUri(artist.providerKey ?? `/library/metadata/${artist.id}`)
      void playFromUri(uri, true, artist.title, `/artist/${artist.id}`)
      close()
    }
  }

  function doRadio() {
    const id = track?.id ?? album?.id ?? artist?.id
    const radioType = track ? "track" : album ? "album" : "artist"
    if (id) void playRadio(id, radioType as "track" | "album" | "artist")
    close()
  }

  function doShare(url: string) {
    void open(url)
    close()
  }

  function goToArtist() {
    if (track?.artistId) navigate(`/artist/${track.artistId}`)
    close()
  }

  function goToAlbum() {
    if (track?.albumId) navigate(`/album/${track.albumId}`)
    close()
  }

  function doRemoveFromPlaylist() {
    if (!track || !ctxPlaylistId || !provider || !track.playlistItemId) return
    const current = captureOwner()
    void provider.removeFromPlaylist(ctxPlaylistId, [track.playlistItemId]).then(() => {
      if (current()) useLibraryStore.getState().invalidatePlaylistItems(ctxPlaylistId)
    }).catch(() => failed(current))
    close()
  }

  // Determine item IDs for "add to playlist"
  const itemIds = track
    ? [track.id]
    : album
    ? [album.id]
    : artist
    ? [artist.id]
    : []

  // Rating data
  const itemId = data.id
  const userRating = (data as MusicTrack | MusicAlbum | MusicArtist).userRating ?? null
  const artistName = track?.artistName ?? album?.artistName ?? artist?.title ?? ""
  const itemTitle = track?.title ?? album?.title ?? artist?.title ?? ""

  // Share URLs
  const lfmArtistUrl = lfmUrl("artist", artistName)
  const lfmItemUrl = track
    ? lfmUrl("track", artistName, itemTitle)
    : album
    ? lfmUrl("album", artistName, itemTitle)
    : null

  // ── Playlist menu (separate, simpler layout) ──────────────────────────
  if (playlist) {
    const isEditable = !playlist.smart
    const href = `/playlist/${playlist.id}`

    function doPlayPlaylist() {
      if (!provider?.buildPlaylistUri || !playlist!.providerKey) return
      void playFromUri(
        provider.buildPlaylistUri(playlist!.providerKey),
        false,
        playlist!.title,
        href,
      )
      close()
    }

    function doShufflePlaylist() {
      if (!provider?.buildPlaylistUri || !playlist!.providerKey) return
      void playFromUri(
        provider.buildPlaylistUri(playlist!.providerKey),
        true,
        playlist!.title,
        href,
      )
      close()
    }

    function doRenamePlaylist(newName: string) {
      if (!provider) return
      const current = captureOwner()
      void provider.editPlaylist(playlist!.id, newName).then(() => {
        if (current()) useLibraryStore.getState().renamePlaylist(playlist!.id, newName)
      }).catch(() => failed(current))
      close()
    }

    function doDeletePlaylist() {
      if (!provider) return
      const current = captureOwner()
      void provider.deletePlaylist(playlist!.id).then(() => {
        if (!current()) return
        useLibraryStore.getState().removePlaylist(playlist!.id)
        // Navigate away if currently viewing this playlist
        if (window.location.hash.slice(1).split("?")[0] === href ||
            window.location.pathname === href) {
          navigate("/")
        }
      }).catch(() => failed(current))
      close()
    }

    return (
      <>
        <div className="fixed inset-0 z-[9998]" onContextMenu={e => { e.preventDefault(); close() }} onClick={close} />
        <div
          ref={menuRef}
          style={{ left: menuPos.left, top: menuPos.top }}
          className="fixed z-[9999] w-60 rounded-lg border border-white/10 bg-app-card shadow-2xl py-1 text-sm select-none"
        >
          {renaming ? (
            <InlineRenameInput
              initialValue={playlist.title}
              onConfirm={doRenamePlaylist}
              onCancel={() => setRenaming(false)}
            />
          ) : confirming ? (
            <InlineDeleteConfirm
              title={playlist.title}
              onConfirm={doDeletePlaylist}
              onCancel={() => setConfirming(false)}
            />
          ) : (
            <>
              <Item icon={IconPlay} label="Play" onClick={doPlayPlaylist} />
              <Item icon={IconShuffle} label="Play shuffled" onClick={doShufflePlaylist} />
              {hasRadio && <Item icon={IconRadio} label="Start radio" onClick={() => {
                void playRadio(playlist.id, "track")
                close()
              }} />}
              <Divider />
              {isEditable && <Item icon={IconEdit} label="Rename" onClick={() => setRenaming(true)} />}
              <Item icon={IconDelete} label="Delete" onClick={() => setConfirming(true)} danger />
              {debugEnabled && (
                <>
                  <Divider />
                  <SectionLabel label="Debug" />
                  <Item
                    icon={IconBug}
                    label="Debug Info"
                    onClick={() => { showDebugPanel(type!, data!); close() }}
                  />
                </>
              )}
            </>
          )}
        </div>
      </>
    )
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[9998]" onContextMenu={e => { e.preventDefault(); close() }} onClick={close} />

      {/* Menu */}
      <div
        ref={menuRef}
        style={{ left: menuPos.left, top: menuPos.top }}
        className="fixed z-[9999] w-60 rounded-lg border border-white/10 bg-app-card shadow-2xl py-1 text-sm select-none"
      >
        {/* Play */}
        <Item
          icon={IconPlay}
          label={type === "track" ? "Play now" : type === "album" ? "Play album" : "Play all"}
          onClick={doPlay}
        />
        {(track || album) && <Item icon={IconNext} label="Play next" onClick={doAddNext} />}
        <Item icon={IconQueue} label="Add to bottom" onClick={doQueue} />
        {hasRadio && <Item icon={IconRadio} label="Start radio" onClick={doRadio} />}

        <Divider />

        {/* Rating */}
        {hasRatings && <StarRating
          key={generation}
          itemId={itemId}
          itemType={type === "album" ? "album" : type === "artist" ? "artist" : "track"}
          userRating={userRating}
          enableLove={type === "track"}
          artist={artistName}
          track={itemTitle}
          size={14}
          onRated={() => { if (currentMenu()) close() }}
        />}

        {/* Remove from playlist — when in a playlist context and track has playlistItemId */}
        {track && ctxPlaylistId && track.playlistItemId && (
          <>
            <Divider />
            <Item icon={IconRemove} label="Remove from playlist" onClick={doRemoveFromPlaylist} danger />
          </>
        )}

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
              onClick={() => { if (album.artistId) navigate(`/artist/${album.artistId}`); close() }}
            />
          </>
        )}

        {debugEnabled && (
          <>
            <Divider />
            <SectionLabel label="Debug" />
            <Item
              icon={IconBug}
              label="Debug Info"
              onClick={() => { showDebugPanel(type!, data!); close() }}
            />
          </>
        )}
      </div>
    </>
  )
}
