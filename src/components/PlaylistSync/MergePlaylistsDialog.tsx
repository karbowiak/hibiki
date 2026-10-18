import { useEffect, useId, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "wouter"
import { IconX, IconPhoto } from "@tabler/icons-react"
import { useLibraryPlaylists } from "../../hooks/useLibraryPlaylists"
import { useModalLifecycle } from "../../hooks/useModalLifecycle"
import { captureMusicOwner, createPlaylistCounterpartResolver } from "../../mixedPlaylists/counterparts"
import { mixedAdapters } from "../../mixedPlaylists/adapters"
import { mixedPlaylistRepository } from "../../mixedPlaylists/repository"
import { prepareMerge, readMergeSource, mergeDuplicateCount, mergeServices, type MergePreview, type MergeDestination, type MergeDuplicates } from "../../mixedPlaylists/merge"
import { projection, unsupportedPlexRepeats } from "../../mixedPlaylists/reconcile"
import { mergedDraft } from "../../mixedPlaylists/merge"
import { defaultPlaylistSync } from "../../mixedPlaylists/drafts"
import { useMixedPlaylistStore } from "../../stores/mixedPlaylistStore"
import { artworkFile } from "../../lib/playlistArtwork"
import { MusicSourceBadge } from "../shared/MusicSource"
import { Button } from "../shared/Button"
import { Select } from "../shared/Select"
import { beginActivity } from "../../activity/store"

export function MergePlaylistsDialog({ onClose }: { onClose(): void }) {
  const { playlists } = useLibraryPlaylists()
  const [, navigate] = useLocation()
  const [first, setFirst] = useState("")
  const [second, setSecond] = useState("")
  const [destination, setDestination] = useState<MergeDestination>("mixed")
  const [duplicates, setDuplicates] = useState<MergeDuplicates>("preserve")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [artwork, setArtwork] = useState<string | null>(null)
  const [preview, setPreview] = useState<MergePreview | null>(null)
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState<"review" | "save" | "image" | null>(null)
  const [progress, setProgress] = useState("")
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null), initialFocus = useRef<HTMLButtonElement>(null), file = useRef<HTMLInputElement>(null)
  const lifetime = useRef({ active: true, request: 0, saving: false })
  const id = useRef(`mixed:${crypto.randomUUID()}`)
  const reviewOwner = useRef<ReturnType<typeof captureMusicOwner> | null>(null)
  const reviewActivity = useRef<ReturnType<typeof beginActivity> | null>(null)
  const label = useId()
  useEffect(() => { lifetime.current.active = true; return () => { lifetime.current.active = false; lifetime.current.request++; reviewActivity.current?.finish() } }, [])
  useModalLifecycle(dialog, { onClose, initialFocus, ownTabOrder: true, canClose: busy !== "save" })
  const reset = () => { lifetime.current.request++; setPreview(null); setError(null); setPage(0) }
  const metadata = { title: name, description, artwork, external: defaultPlaylistSync() }
  const draft = useMemo(() => preview ? mergedDraft(preview, { title: "Merge preview", description: "", artwork: null, external: defaultPlaylistSync() }, preview.owners, id.current) : null, [preview])
  const services = mergeServices(destination)
  const pending = preview?.items.filter(row => services.some(service => !row.songs[service] || row.songs[service]?.stale)) ?? []
  async function review() {
    if (busy || !first || !second || first === second) return
    const session = lifetime.current, request = ++session.request, capture = captureMusicOwner()
    let cancelled = false
    const current = () => !cancelled && session.active && session.request === request && capture.current()
    const activity = beginActivity({ id: `merge-review:${id.current}`, label: "Reviewing playlist merge", detail: "Reading both playlists", busy: true }, current)
    reviewActivity.current = activity
    setBusy("review"); setError(null); setPreview(null); setProgress("Reading both playlists completely…")
    try {
      const options = { ...capture, current, adapters: mixedAdapters({ ...capture, current }), local: mixedPlaylistRepository.load }
      const sources = await Promise.all([readMergeSource(first, options), readMergeSource(second, options)])
      if (!current()) throw Error("Music accounts changed. Review the merge again.")
      const resolve = createPlaylistCounterpartResolver(sources.flatMap(source => source.items.flatMap(row => row.songs[row.original] ? [row.songs[row.original]!.track] : [])), false, current)
      const result = await prepareMerge([sources[0], sources[1]], destination, duplicates, { ...capture, current, resolve,
        progress: (done, total) => { if (current()) {
          setProgress(`Checking destination coverage · ${done.toLocaleString()} of ${total.toLocaleString()} songs`)
          activity.update({ detail: `${done.toLocaleString()} of ${total.toLocaleString()} songs checked`, progress: { value: done, total, label: "Merge songs checked" } })
        } } })
      if (!current()) return
      reviewOwner.current = capture; setPreview(result); setPage(0)
      if (!name.trim()) setName(`${sources[0].title} + ${sources[1].title}`.slice(0, 500))
    } catch (failure) { cancelled = true; if (session.active && session.request === request) setError(String(failure instanceof Error ? failure.message : failure)) }
    finally { activity.finish(); if (session.active && session.request === request) setBusy(null) }
  }
  async function save() {
    if (!preview || !name.trim() || busy || lifetime.current.saving) return
    if (!reviewOwner.current?.current()) { setError("Music accounts changed. Review the merge again."); return }
    lifetime.current.saving = true; setBusy("save"); setError(null)
    try {
      const created = await useMixedPlaylistStore.getState().createMerge(preview, metadata, id.current)
      if (!lifetime.current.active) return
      navigate(`/mixed-playlist/${encodeURIComponent(created.id)}`); onClose()
    } catch (failure) { if (lifetime.current.active) setError(String(failure instanceof Error ? failure.message : failure)) }
    finally { lifetime.current.saving = false; if (lifetime.current.active) setBusy(null) }
  }
  async function image(selected?: File) {
    if (!selected) return
    setBusy("image"); setError(null)
    try { const value = await artworkFile(selected); if (lifetime.current.active) setArtwork(value) }
    catch (failure) { if (lifetime.current.active) setError(String(failure instanceof Error ? failure.message : failure)) }
    finally { if (lifetime.current.active) setBusy(null) }
  }
  return createPortal(<dialog ref={dialog} aria-modal="true" aria-labelledby={label}
    className="fixed inset-0 z-20000 m-0 h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-black/60 p-0 text-(--text-primary) backdrop-blur-sm backdrop:bg-transparent open:flex"
    onCancel={event => { event.preventDefault(); if (busy !== "save") onClose() }} onKeyDown={event => event.stopPropagation()}
    onClick={event => { if (event.target === event.currentTarget && busy !== "save") onClose() }}>
    <div className="app-overlay-surface playlist-editor max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl bg-app-surface p-6">
      <header className="mb-5 flex items-center justify-between gap-4"><h2 id={label} className="text-xl font-bold">Merge playlists</h2>
        <Button variant="ghost" size="icon" aria-label="Close merge playlists" disabled={busy === "save"} onClick={onClose}><IconX size={20} aria-hidden="true" /></Button></header>
      <p className="mb-5 text-sm leading-relaxed text-(--text-secondary)">Create a new playlist from two collections. The first playlist’s songs come first. Both originals stay as they are.</p>
      <fieldset disabled={!!busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className="min-w-0 space-y-2 text-sm font-semibold"><span className="block">First playlist</span><Select ref={element => { initialFocus.current = element?.parentElement?.querySelector<HTMLButtonElement>('[role="combobox"]') ?? null }} aria-label="First playlist" className="w-full" value={first} onChange={event => { reset(); setFirst(event.target.value) }}>
          <option value="">Choose a playlist</option>{playlists.filter(item => item.id !== second).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></label>
        <label className="min-w-0 space-y-2 text-sm font-semibold"><span className="block">Second playlist</span><Select aria-label="Second playlist" className="w-full" value={second} onChange={event => { reset(); setSecond(event.target.value) }}>
          <option value="">Choose a playlist</option>{playlists.filter(item => item.id !== first).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></label>
        <label className="min-w-0 space-y-2 text-sm font-semibold"><span className="block">Create on</span><Select aria-label="Merge destination" className="w-full" value={destination} onChange={event => { reset(); setDestination(event.target.value as MergeDestination) }}>
          <option value="mixed">Plex + YouTube Music</option><option value="plex">Plex only</option><option value="ytmusic">YouTube Music only</option></Select></label>
        <label className="min-w-0 space-y-2 text-sm font-semibold"><span className="block">Repeated songs</span><Select aria-label="Merge duplicate policy" className="w-full" value={duplicates} onChange={event => { reset(); setDuplicates(event.target.value as MergeDuplicates) }}>
          <option value="preserve">Keep every occurrence</option><option value="verified">Remove verified duplicates</option></Select></label>
      </fieldset>
      <div className="mt-5 flex flex-wrap items-center gap-3"><Button disabled={!!busy || !first || !second || first === second} onClick={() => void review()}>{preview ? "Refresh review" : "Review merge"}</Button>
        {busy === "review" && <p role="status" className="text-sm text-(--text-secondary)">{progress}</p>}</div>
      {preview && draft && <div className="mt-6 space-y-5 border-t border-(--border) pt-5">
        <div className="space-y-2 text-sm"><h3 className="font-semibold">{preview.items.length.toLocaleString()} songs in the new playlist</h3>
          <p className="text-(--text-secondary)">{preview.removed ? `${preview.removed} verified duplicate occurrences removed.` : `${mergeDuplicateCount(preview.items)} verified repeated occurrences retained.`} Different recordings and uncertain matches stay separate.</p>
          <p className="text-(--text-secondary)">{services.map(service => `${service === "plex" ? "Plex" : "YTM"}: ${projection(draft, service).length} representable`).join(" · ")}{pending.length ? ` · ${pending.length} songs missing a destination match` : " · Full destination coverage"}</p>
          {services.includes("plex") && unsupportedPlexRepeats(draft) > 0 && <p className="text-(--text-secondary)">Plex cannot retain {unsupportedPlexRepeats(draft)} repeated copies. Every occurrence stays in Hibiki{services.includes("ytmusic") ? " and YTM" : ""}.</p>}
          <ol start={page * 50 + 1} aria-label="Merged song order" className="max-h-56 list-decimal space-y-2 overflow-y-auto pl-7 pr-2">
            {preview.items.slice(page * 50, (page + 1) * 50).map(row => <li key={row.id} className="pl-1"><span className="flex min-w-0 items-center gap-2"><MusicSourceBadge source={row.original} /><span className="min-w-0 truncate">{row.songs[row.original]!.track.title} · {row.songs[row.original]!.track.artistName}</span></span>
              {services.some(service => !row.songs[service] || row.songs[service]?.stale) && <small className="text-(--text-secondary)">{row.match.status}: {row.match.message ?? "Awaiting a verified counterpart"}</small>}</li>)}
          </ol>
          {preview.items.length > 50 && <div className="flex items-center gap-3"><Button disabled={!page || !!busy} onClick={() => setPage(value => value - 1)}>Previous</Button><span>{page + 1} / {Math.ceil(preview.items.length / 50)}</span><Button disabled={(page + 1) * 50 >= preview.items.length || !!busy} onClick={() => setPage(value => value + 1)}>Next</Button></div>}
        </div>
        <fieldset disabled={!!busy} className="space-y-4">
          <label className="block space-y-2 text-sm font-semibold"><span>Playlist name</span><input className="app-input w-full" required maxLength={500} value={name} onChange={event => setName(event.target.value)} /></label>
          <label className="block space-y-2 text-sm font-semibold"><span>Description (optional)</span><textarea className="app-input w-full resize-y" rows={2} maxLength={5000} value={description} onChange={event => setDescription(event.target.value)} /></label>
          <div className="flex items-center gap-3">{artwork ? <img src={artwork} alt="Playlist artwork preview" className="h-16 w-16 rounded-lg object-cover" /> : <IconPhoto size={24} aria-hidden="true" />}
            <Button onClick={() => file.current?.click()}>{artwork ? "Replace image" : "Choose image"}</Button>{artwork && <Button variant="ghost" onClick={() => setArtwork(null)}>Remove image</Button>}
            <input ref={file} type="file" aria-label="Merged playlist image" accept="image/jpeg,image/png,image/webp" hidden onChange={event => { void image(event.target.files?.[0]); event.target.value = "" }} /></div>
          <p className="text-xs text-(--text-secondary)">Artwork is saved in Hibiki and synced to Plex. YTM keeps its own image.</p>
        </fieldset>
        <p className="text-sm text-(--text-secondary)">All songs are saved in Hibiki first. Verified matches sync automatically; unavailable songs stay here for retry. Provider edits continue to sync with this new playlist.</p>
      </div>}
      {error && <p role="alert" className="mt-4 text-sm text-(--danger)">{error}</p>}
      <footer className="mt-6 flex flex-wrap justify-end gap-3"><Button disabled={busy === "save"} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!preview || !name.trim() || !!busy} onClick={() => void save()}>{busy === "save" ? "Saving merge…" : "Create merged playlist"}</Button></footer>
    </div>
  </dialog>, document.body)
}
