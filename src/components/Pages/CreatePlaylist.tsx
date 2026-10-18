import { artworkFile } from "../../lib/playlistArtwork"
import { Button } from "../shared/Button"
import { Checkbox } from "../shared/Checkbox"
import { Select } from "../shared/Select"
import { useModalLifecycle } from "../../hooks/useModalLifecycle"
import { createPortal } from "react-dom"
import { useId, useLayoutEffect, useRef, useState } from "react"
import type { MusicPlaylist } from "../../types/music"
import { playlistServices, type MixedPlaylist } from "../../mixedPlaylists/model"
import { defaultPlaylistSync } from "../../mixedPlaylists/drafts"
import { createLocalPlaylist, draftPlaylistSummary } from "../../mixedPlaylists/create"
import { useMixedPlaylistStore } from "../../stores/mixedPlaylistStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
import { IconCheck, IconPhoto, IconX } from "@tabler/icons-react"


export function CreatePlaylist({ onClose, onCreated, itemIds = [], playlist }: {
  onClose: () => void
  onCreated?: (playlist: MusicPlaylist) => void | Promise<void>
  itemIds?: string[]
  playlist?: MixedPlaylist
}) {
  const titleId = useId(), inputId = useId(), descriptionId = useId(), artworkId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null), inputRef = useRef<HTMLInputElement>(null), closeRef = useRef<HTMLButtonElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const creationId = useRef(playlist?.id ?? `mixed:${crypto.randomUUID()}`)
  const lifetime = useRef({ active: true, pending: false, completed: false, image: 0 })
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [name, setName] = useState(playlist?.title ?? "")
  const [description, setDescription] = useState(playlist?.description ?? "")
  const [artwork, setArtwork] = useState<string | null>(playlist?.artwork ?? null)
  const [external, setExternal] = useState(playlist?.external ?? defaultPlaylistSync())
  const [automatic, setAutomatic] = useState(playlist?.automatic ?? true)
  const [unmatchedLimit, setUnmatchedLimit] = useState(50)
  const retained = useMixedPlaylistStore(state => state.playlists.find(item => item.id === playlist?.id)) ?? playlist
  const services = retained ? playlistServices(retained) : []
  const unmatched = retained?.items.filter(row => services.some(service => !row.songs[service] || row.songs[service]?.stale)) ?? []
  const metadataReadOnly = !!playlist && !playlist.local
  const [created, setCreated] = useState(false), [busy, setBusy] = useState(false), [imageBusy, setImageBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listenbrainz = useListenBrainzStore(state => state.isAuthenticated)
  useLayoutEffect(() => {
    const session = { active: true, pending: false, completed: false, image: 0 }
    lifetime.current = session
    return () => { session.active = false; if (closeTimer.current) clearTimeout(closeTimer.current) }
  }, [])
  useModalLifecycle(dialogRef, { onClose, initialFocus: inputRef, ownTabOrder: true })
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const session = lifetime.current
    if (!name.trim() || !session.active || session.pending || session.completed || imageBusy) return
    session.pending = true; setBusy(true); setError(null)
    try {
      const metadata = { title: name, description, artwork, external, automatic }
      let result: MusicPlaylist
      if (playlist) {
        if (playlist.local) await useMixedPlaylistStore.getState().metadata(playlist.id, metadata)
        else await useMixedPlaylistStore.getState().automatic(playlist.id, automatic)
        result = draftPlaylistSummary({ ...playlist, ...metadata })
      } else result = await createLocalPlaylist(metadata, [...itemIds], creationId.current)
      if (!session.active) return
      session.completed = true; setCreated(true); closeRef.current?.focus()
      await onCreated?.(result)
      if (session.active) closeTimer.current = setTimeout(() => { if (session.active) onClose() }, 900)
    } catch (failure) {
      if (session.active) setError(failure instanceof Error ? failure.message : String(failure))
    } finally { if (session.active) { session.pending = false; setBusy(false) } }
  }
  async function selectArtwork(file?: File) {
    if (!file) return
    const session = lifetime.current, request = ++session.image
    setImageBusy(true); setError(null)
    try {
      const value = await artworkFile(file)
      if (session.active && request === session.image) setArtwork(value)
    } catch (failure) {
      if (session.active && request === session.image) setError(failure instanceof Error ? failure.message : "This image could not be opened.")
    } finally { if (session.active && request === session.image) setImageBusy(false) }
  }
  return createPortal(<dialog ref={dialogRef} aria-modal="true" aria-labelledby={titleId}
    className="fixed inset-0 z-20000 m-0 h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-black/60 p-0 text-white backdrop-blur-sm backdrop:bg-transparent open:flex"
    onClick={event => { if (event.target === event.currentTarget) onClose() }} onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => event.stopPropagation()}>
    <div className="app-overlay-surface playlist-editor max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl bg-app-surface p-6">
      <div className="mb-5 flex items-center justify-between gap-4"><h2 id={titleId} className="text-xl font-bold">{playlist ? "Edit playlist" : "Create playlist"}</h2>
        <Button variant="bare" ref={closeRef} type="button" aria-label="Close create playlist" onClick={onClose} className="player-panel-icon"><IconX size={20} aria-hidden="true" /></Button>
      </div>
      {created ? <div className="py-4 text-center"><IconCheck size={36} aria-hidden="true" className="mx-auto mb-3 text-accent" /><p role="status" className="font-semibold">Saved in Hibiki</p>{error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}</div> :
        <form onSubmit={submit} className="space-y-5">
          <div className="flex items-center gap-4">
            <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-app-card">
              {artwork ? <img src={artwork} alt="Playlist artwork preview" className="h-full w-full object-cover" /> : <IconPhoto size={30} aria-hidden="true" className="text-(--text-muted)" />}
            </div>
            <div className="min-w-0 space-y-2"><Button size="md" variant="secondary" type="button" disabled={busy || imageBusy || metadataReadOnly} onClick={() => fileRef.current?.click()} className="media-secondary">{imageBusy ? "Preparing image…" : artwork ? "Replace image" : "Choose image"}</Button>
              <input ref={fileRef} id={artworkId} aria-label="Playlist image" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || imageBusy} tabIndex={-1} className="hidden" onChange={event => { void selectArtwork(event.target.files?.[0]); event.target.value = "" }} />
              {artwork && <Button variant="bare" type="button" disabled={busy || metadataReadOnly} title="Remove the image in Hibiki. Synced services retain their current image." onClick={() => { ++lifetime.current.image; setArtwork(null); setImageBusy(false) }} className="block text-sm text-(--text-secondary) underline underline-offset-4">Remove image</Button>}
            </div>
          </div>
          <div className="space-y-2"><label htmlFor={inputId} className="block text-sm font-semibold">Playlist name</label>
            <input ref={inputRef} id={inputId} disabled={busy} readOnly={metadataReadOnly} required maxLength={500} value={name} onChange={event => setName(event.target.value)} placeholder="My playlist" className="app-input w-full" />
          </div>
          <div className="space-y-2"><label htmlFor={descriptionId} className="block text-sm font-semibold">Description <span className="font-normal text-(--text-muted)">(optional)</span></label>
            <textarea id={descriptionId} disabled={busy} readOnly={metadataReadOnly} maxLength={5000} rows={3} value={description} onChange={event => setDescription(event.target.value)} className="app-input w-full resize-y" />
          </div>
          {playlist && <fieldset disabled={busy} className="space-y-3 border-t border-(--border) pt-4"><legend className="px-0 text-sm font-semibold">Playlist sync</legend>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={automatic} onChange={event => setAutomatic(event.target.checked)} />Automatic sync</label>
            {unmatched.length > 0 && <details><summary className="cursor-pointer text-sm">{unmatched.length} unmatched songs</summary>
              <ul className="mt-3 max-h-60 space-y-3 overflow-y-auto text-sm">{unmatched.slice(0, unmatchedLimit).map(row => <li key={row.id}>
                <p>{row.songs[row.original]?.track.title} · {row.songs[row.original]?.track.artistName}</p>
                <p className="mt-1 text-xs text-(--text-secondary)">Missing {services.filter(service => !row.songs[service] || row.songs[service]?.stale).map(service => service === "plex" ? "Plex" : "YTM").join(" and ")}{row.match.message ? ` · ${row.match.message}` : ""}</p>
              </li>)}</ul>
              {unmatchedLimit < unmatched.length && <Button type="button" className="mt-3" onClick={() => setUnmatchedLimit(value => value + 50)}>Show more songs</Button>}
            </details>}
          </fieldset>}
          <fieldset disabled={busy || metadataReadOnly} className="space-y-3 border-t border-(--border) pt-4"><legend className="px-0 text-sm font-semibold">External sync</legend>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={external.listenbrainz.enabled} onChange={event => setExternal({ listenbrainz: { ...external.listenbrainz, enabled: event.target.checked } })} />ListenBrainz</label>
            {external.listenbrainz.enabled && <div className="space-y-3 pl-5 text-sm">
              {!listenbrainz && <p className="text-(--text-secondary)">Connect ListenBrainz in Settings when you’re ready. Your preference is saved here.</p>}
              <label className="flex flex-wrap items-center gap-2">Direction<Select aria-label="ListenBrainz sync direction" value={external.listenbrainz.direction} onChange={event => setExternal({ listenbrainz: { ...external.listenbrainz, direction: event.target.value as "export" | "import" | "two-way" } })}><option value="export">Hibiki → ListenBrainz</option><option value="import">ListenBrainz → Hibiki</option><option value="two-way">Both ways</option></Select></label>
              <label className="flex items-center gap-2"><Checkbox checked={external.listenbrainz.automatic} onChange={event => setExternal({ listenbrainz: { ...external.listenbrainz, automatic: event.target.checked } })} />Sync automatically</label>
            </div>}
            {artwork && <p className="text-xs text-(--text-secondary)">Artwork syncs to Plex. YTM and ListenBrainz keep their own images.</p>}
          </fieldset>
          {!playlist && <p className="text-sm leading-relaxed text-(--text-secondary)">Saved on this device first. Adding songs connects the playlist to their music services.</p>}
          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-3 pt-1"><Button size="md" variant="secondary" type="button" onClick={onClose} className="media-secondary">Cancel</Button><Button size="md" variant="primary" type="submit" disabled={!name.trim() || busy || imageBusy} className="media-primary">{busy ? "Saving…" : playlist ? "Save changes" : "Create"}</Button></div>
        </form>}
    </div>
  </dialog>, document.body)
}
