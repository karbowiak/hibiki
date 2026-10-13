import { useEffect, useRef, useState } from "react"
import { useProviderStore } from "../../stores/providerStore"
import type { LibraryArtworkInventory } from "../../providers/types"
import { buildExternalImageUrl } from "../../lib/imageUrl"
import { ArtworkImage } from "./ArtworkImage"
import { metadataEditError } from "../../lib/metadataEdit"

export function PlexArtworkPanel({ kind, itemId, role, disabled = false, onBusy, onSaved }:
  { kind: "artist" | "album"; itemId: string; role: "poster" | "background"; disabled?: boolean; onBusy: (busy: boolean) => void; onSaved: () => void }) {
  const owner = useRef(useProviderStore.getState().provider).current
  const active = useRef(true), writing = useRef(false), request = useRef(0), input = useRef<HTMLInputElement>(null)
  const owns = () => active.current && useProviderStore.getState().provider === owner
  const [inventory, setInventory] = useState<LibraryArtworkInventory | null>(null)
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [reloadRequired, setReloadRequired] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [selection, setSelection] = useState<{ choice: string } | { file: File; url: string } | null>(null)
  const selectionUrl = selection && "url" in selection ? selection.url : null
  useEffect(() => () => { if (selectionUrl) URL.revokeObjectURL(selectionUrl) }, [selectionUrl])
  async function reload() {
    if (!owner?.getArtworkInventory || writing.current || !owns()) return
    const version = ++request.current
    setLoading(true); setMessage(null)
    try {
      const result = await owner.getArtworkInventory(kind, itemId, role)
      if (!owns() || version !== request.current) return
      setInventory(result); setSelection(null); setReloadRequired(false)
    } catch { if (owns() && version === request.current) setMessage("Could not load Plex artwork choices. You can retry below.") }
    finally { if (owns() && version === request.current) setLoading(false) }
  }
  useEffect(() => { active.current = true; void reload(); return () => { active.current = false; request.current++ } }, [kind, itemId, role, owner])
  async function save() {
    if (!owner?.saveArtwork || !owns() || writing.current || disabled || !inventory || !selection || reloadRequired) return
    writing.current = true; setBusy(true); onBusy(true); setMessage(null)
    try {
      const change = "choice" in selection ? { choice: selection.choice } : { upload: Array.from(new Uint8Array(await selection.file.arrayBuffer())) }
      if (!owns()) return
      const result = await owner.saveArtwork(kind, itemId, role, inventory.baseline, change)
      if (!owns()) return
      setInventory(result); setSelection(null); setMessage("Artwork saved to Plex."); onSaved()
    } catch (error) {
      if (!owns()) return
      const problem = metadataEditError(error)
      setMessage(problem.message); setReloadRequired(problem.reload)
    } finally { writing.current = false; if (owns()) { setBusy(false); onBusy(false) } }
  }
  if (!owner?.getArtworkInventory || !owner.saveArtwork || owner.isOffline) return null
  const selected = selection && "choice" in selection ? inventory?.candidates.find(c => c.id === selection.choice) : null
  const proposedImage = selectionUrl ?? (selected?.sourceUrl ? buildExternalImageUrl(selected.sourceUrl, owner.cacheScope) : null)
  return <section className="metadata-edit-section space-y-4" aria-label={`Plex ${role} inventory`}>
    <div><h4 className="metadata-edit-section-title">Images in your Plex library</h4>
      <p className="metadata-edit-note">Choose from Plex’s {role === "poster" ? "posters" : "backgrounds"}, or upload an image. Review the choice below before saving.</p></div>
    {loading && <p role="status" className="metadata-edit-note">Loading Plex images…</p>}
    {!!inventory?.candidates.length && <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-3">{inventory.candidates.map(candidate => {
      const picked = selection && "choice" in selection && selection.choice === candidate.id
      return <button type="button" key={candidate.id} className={`overflow-hidden rounded-lg border p-2 text-left transition-colors hover:bg-app-surface-hover ${picked ? "border-[var(--artwork-primary)]" : "border-[var(--border)]"}`} disabled={disabled || busy || loading || reloadRequired || candidate.selected} aria-pressed={!!picked} onClick={() => setSelection({ choice: candidate.id })}>
        {candidate.sourceUrl ? <ArtworkImage src={buildExternalImageUrl(candidate.sourceUrl, owner.cacheScope)} alt={`${candidate.label} ${role}`} className={`w-full rounded-md object-cover ${role === "background" ? "aspect-video" : "aspect-square"}`} /> : <span className="flex aspect-square items-center justify-center rounded-md bg-app-surface text-xs text-[var(--text-muted)]">Preview unavailable</span>}
        <span className="mt-2 block truncate text-xs font-medium">{candidate.label}</span>
        <span className="metadata-edit-note block text-xs">{candidate.selected ? "Current in Plex" : picked ? "Selected for review" : "Choose image"}</span>
      </button>
    })}</div>}
    {inventory && !inventory.candidates.length && <p className="metadata-edit-note">Plex has no alternate images for this item.</p>}
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/bmp,image/avif" className="hidden" aria-label={`Upload Plex ${role}`} onChange={e => {
      const file = e.target.files?.[0]; e.target.value = ""
      if (!file || disabled || busy || reloadRequired) return
      if (file.size <= 0 || file.size > 8 * 1024 * 1024) { setMessage("Choose an image up to 8 MiB."); return }
      setSelection({ file, url: URL.createObjectURL(file) }); setMessage(null)
    }} />
    <div className="flex flex-wrap gap-2">
      <button type="button" className="metadata-edit-button" disabled={disabled || busy || loading || reloadRequired} onClick={() => input.current?.click()}>Upload image…</button>
      <button type="button" className="metadata-edit-button" disabled={disabled || busy || loading} onClick={() => void reload()}>{reloadRequired ? "Reload current artwork" : "Reload choices"}</button>
    </div>
    {selection && <div className="rounded-lg border border-[var(--border)] p-4">
      <h5 className="font-semibold">After saving to Plex</h5>
      {proposedImage && <ArtworkImage src={proposedImage} alt={`Proposed ${role}`} className={`mt-3 max-h-40 rounded-md object-contain ${role === "background" ? "w-60" : "w-36"}`} />}
      <p className="metadata-edit-note mt-3">{"file" in selection ? selection.file.name : selected?.label} · This changes the {role} in your Plex library.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="metadata-edit-button metadata-edit-button--primary" disabled={disabled || busy || loading || reloadRequired} onClick={() => void save()}>{busy ? "Saving…" : `Save ${role} to Plex`}</button>
        <button type="button" className="metadata-edit-button" disabled={busy} onClick={() => setSelection(null)}>Cancel choice</button>
      </div>
    </div>}
    {message && <p role={reloadRequired ? "alert" : "status"} className="metadata-edit-note">{message}</p>}
  </section>
}
