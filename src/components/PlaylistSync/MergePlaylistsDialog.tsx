import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "wouter"
import { IconX, IconPhoto } from "@tabler/icons-react"
import { useLibraryPlaylists, type LibraryPlaylist } from "../../hooks/useLibraryPlaylists"
import { useModalLifecycle } from "../../hooks/useModalLifecycle"
import type { MergeDestination, MergeDuplicates } from "../../mixedPlaylists/merge"
import { defaultPlaylistSync } from "../../mixedPlaylists/drafts"
import { playlistSourceLabel } from "../../mixedPlaylists/model"
import { useMixedPlaylistStore } from "../../stores/mixedPlaylistStore"
import { artworkFile } from "../../lib/playlistArtwork"
import { PlaylistSourceBadge } from "../shared/LibraryPlaylistCard"
import { Button } from "../shared/Button"
import { Select } from "../shared/Select"

export function MergePlaylistsDialog({ onClose }: { onClose(): void }) {
  const { playlists, youtube } = useLibraryPlaylists({ collapseLinked: false })
  const [, navigate] = useLocation()
  const [first, setFirst] = useState("")
  const [second, setSecond] = useState("")
  const [destination, setDestination] = useState<MergeDestination>("mixed")
  const [duplicates, setDuplicates] = useState<MergeDuplicates>("verified")
  const [name, setName] = useState<string | null>(null)
  const [description, setDescription] = useState("")
  const [artwork, setArtwork] = useState<string | null>(null)
  const [busy, setBusy] = useState<"save" | "image" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null), initialFocus = useRef<HTMLButtonElement>(null), file = useRef<HTMLInputElement>(null)
  const active = useRef(true), saving = useRef(false)
  const id = useRef(`mixed:${crypto.randomUUID()}`)
  const label = useId()
  const options = new Map(playlists.map(playlist => [playlist.id, playlist]))
  const firstPlaylist = options.get(first), secondPlaylist = options.get(second)
  const suggested = firstPlaylist && secondPlaylist ? firstPlaylist.title === secondPlaylist.title ? firstPlaylist.title : `${firstPlaylist.title} + ${secondPlaylist.title}` : ""
  const title = (name ?? suggested).slice(0, 500)
  const sourceLabel = (playlist: LibraryPlaylist) => playlist.mixed ? playlistSourceLabel(playlist.mixed) : playlist.youtubeMusic ? "YTM" : "Plex"
  const renderPlaylist = ({ value, label }: { value: string; label: string }) => {
    const playlist = options.get(value)
    return playlist ? <span className="flex min-w-0 items-center gap-2"><PlaylistSourceBadge playlist={playlist} /><span className="min-w-0 truncate">{playlist.title}</span></span> : label
  }
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    if (youtube.connected && youtube.more && !youtube.loading && !youtube.error) void youtube.loadMore()
  }, [youtube.connected, youtube.more, youtube.loading, youtube.error, playlists.length])
  useModalLifecycle(dialog, { onClose, initialFocus, ownTabOrder: true, canClose: busy !== "save" })
  async function save() {
    if (!firstPlaylist || !secondPlaylist || first === second || !title.trim() || busy || saving.current) return
    saving.current = true; setBusy("save"); setError(null)
    try {
      const created = await useMixedPlaylistStore.getState().queueMerge(
        [{ key: first, title: firstPlaylist.title }, { key: second, title: secondPlaylist.title }], destination, duplicates,
        { title, description, artwork, external: defaultPlaylistSync() }, id.current)
      if (!active.current) return
      navigate(`/mixed-playlist/${encodeURIComponent(created.id)}`); onClose()
    } catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { saving.current = false; if (active.current) setBusy(null) }
  }
  async function image(selected?: File) {
    if (!selected) return
    setBusy("image"); setError(null)
    try { const value = await artworkFile(selected); if (active.current) setArtwork(value) }
    catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (active.current) setBusy(null) }
  }
  return createPortal(<dialog ref={dialog} aria-modal="true" aria-labelledby={label}
    className="fixed inset-0 z-20000 m-0 h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-black/60 p-0 text-(--text-primary) backdrop-blur-sm backdrop:bg-transparent open:flex"
    onCancel={event => { event.preventDefault(); if (busy !== "save") onClose() }} onKeyDown={event => event.stopPropagation()}
    onClick={event => { if (event.target === event.currentTarget && busy !== "save") onClose() }}>
    <div className="app-overlay-surface playlist-editor max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl bg-app-surface p-6">
      <header className="mb-5 flex items-center justify-between gap-4"><h2 id={label} className="text-xl font-bold">Merge playlists</h2>
        <Button variant="ghost" size="icon" aria-label="Close merge playlists" disabled={busy === "save"} onClick={onClose}><IconX size={20} aria-hidden="true" /></Button></header>
      <p className="mb-5 text-sm leading-relaxed text-(--text-secondary)">The first playlist’s songs come first. Matching and syncing continue in the background. Both originals stay as they are.</p>
      <fieldset disabled={!!busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className="min-w-0 space-y-2 text-sm font-semibold"><span className="block">First playlist</span><Select ref={element => { initialFocus.current = element?.parentElement?.querySelector<HTMLButtonElement>('[role="combobox"]') ?? null }} aria-label="First playlist" className="w-full" renderOption={renderPlaylist} value={first} onChange={event => { setError(null); setFirst(event.target.value) }}>
          <option value="">Choose a playlist</option>{playlists.filter(item => item.id !== second).map(item => <option key={item.id} value={item.id}>{item.title} · {sourceLabel(item)}</option>)}</Select></label>
        <label className="min-w-0 space-y-2 text-sm font-semibold"><span className="block">Second playlist</span><Select aria-label="Second playlist" className="w-full" renderOption={renderPlaylist} value={second} onChange={event => { setError(null); setSecond(event.target.value) }}>
          <option value="">Choose a playlist</option>{playlists.filter(item => item.id !== first).map(item => <option key={item.id} value={item.id}>{item.title} · {sourceLabel(item)}</option>)}</Select></label>
        <label className="min-w-0 space-y-2 text-sm font-semibold"><span className="block">Create on</span><Select aria-label="Merge destination" className="w-full" value={destination} onChange={event => setDestination(event.target.value as MergeDestination)}>
          <option value="mixed">Plex + YouTube Music</option><option value="plex">Plex only</option><option value="ytmusic">YouTube Music only</option></Select></label>
        <label className="min-w-0 space-y-2 text-sm font-semibold"><span className="block">Repeated songs</span><Select aria-label="Merge duplicate policy" className="w-full" value={duplicates} onChange={event => setDuplicates(event.target.value as MergeDuplicates)}>
          <option value="verified">Remove duplicate recordings</option><option value="preserve">Keep every occurrence</option></Select></label>
        <label className="min-w-0 space-y-2 text-sm font-semibold sm:col-span-2"><span className="block">Playlist name</span><input className="app-input w-full" required maxLength={500} value={title} onChange={event => setName(event.target.value)} /></label>
        <label className="min-w-0 space-y-2 text-sm font-semibold sm:col-span-2"><span className="block">Description (optional)</span><textarea className="app-input w-full resize-y" rows={2} maxLength={5000} value={description} onChange={event => setDescription(event.target.value)} /></label>
      </fieldset>
      <div className="mt-4 flex items-center gap-3">{artwork ? <img src={artwork} alt="Playlist artwork preview" className="h-16 w-16 rounded-lg object-cover" /> : <IconPhoto size={24} aria-hidden="true" />}
        <Button disabled={!!busy} onClick={() => file.current?.click()}>{busy === "image" ? "Loading image…" : artwork ? "Replace image" : "Choose image"}</Button>{artwork && <Button disabled={!!busy} variant="ghost" onClick={() => setArtwork(null)}>Remove image</Button>}
        <input ref={file} type="file" aria-label="Merged playlist image" accept="image/jpeg,image/png,image/webp" hidden onChange={event => { void image(event.target.files?.[0]); event.target.value = "" }} /></div>
      {youtube.error && <Button className="mt-4" onClick={() => void youtube.retry()}>Retry loading YTM playlists</Button>}
      {error && <p role="alert" className="mt-4 text-sm text-(--danger)">{error}</p>}
      <footer className="mt-6 flex flex-wrap justify-end gap-3"><Button disabled={busy === "save"} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!firstPlaylist || !secondPlaylist || first === second || !title.trim() || !!busy} onClick={() => void save()}>{busy === "save" ? "Creating playlist…" : "Create merged playlist"}</Button></footer>
    </div>
  </dialog>, document.body)
}
