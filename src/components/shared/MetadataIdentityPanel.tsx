import { Button } from "./Button"
import { useState } from "react"
import { useMetadataIdentityChooser } from "../../hooks/useMetadataIdentityChooser"
import type { MetadataIdentity } from "../../metadata/core/types"
import type { MetadataIdentityCandidate } from "../../metadata/identity/types"
import { HeyaDiscoveryPanel } from "./HeyaDiscoveryPanel"

const sourceName = (candidate: MetadataIdentityCandidate) => candidate.provider === "heya" ? "HeyaMetadata" : "MusicBrainz"

function IdentityEvidence({ candidate }: { candidate: MetadataIdentityCandidate }) {
  return <div className="space-y-3">
    <div><p className="font-semibold">{candidate.title}</p>
      {candidate.kind === "album" && <p className="metadata-edit-note mt-1">{candidate.artist}</p>}
      {candidate.disambiguation && <p className="metadata-edit-note mt-1">{candidate.disambiguation}</p>}
    </div>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      <dt className="metadata-edit-note">Source</dt><dd>{sourceName(candidate)}</dd>
      {candidate.area && <><dt className="metadata-edit-note">Origin</dt><dd>{candidate.area}</dd></>}
      {candidate.releaseDate && <><dt className="metadata-edit-note">Release date</dt><dd>{candidate.releaseDate}</dd></>}
      {candidate.artistType && <><dt className="metadata-edit-note">Artist type</dt><dd>{candidate.artistType}</dd></>}
      {!!candidate.aliases.length && <><dt className="metadata-edit-note">Also known as</dt><dd className="wrap-break-word">{candidate.aliases.map(a => a.name).join(" · ")}</dd></>}
      <dt className="metadata-edit-note">Identity</dt><dd className="break-all font-mono text-xs">{candidate.id}</dd>
    </dl>
  </div>
}

/** Candidate search never changes an item; exact-ID evidence is reviewed first. */
export function MetadataIdentityPanel({ identity, disabled = false }: { identity: MetadataIdentity; disabled?: boolean }) {
  const chooser = useMetadataIdentityChooser(identity)
  const [query, setQuery] = useState(identity.kind === "artist" ? identity.artist : `${identity.artist} ${identity.title ?? ""}`)
  const [message, setMessage] = useState<string | null>(null)
  const locked = disabled || chooser.loading
  return <div className="space-y-5">
    <div><h3 className="text-lg font-semibold">Find the right identity</h3>
      <p className="metadata-edit-note mt-1">Choose the artist or album used for enrichment and artwork. Your Plex title stays as it is.</p>
    </div>
    {chooser.selected && <section className="metadata-edit-section">
      <h4 className="metadata-edit-section-title">Current match</h4>
      <IdentityEvidence candidate={chooser.selected} />
      <Button variant="secondary" type="button" disabled={locked} className="metadata-edit-button mt-4" onClick={() => setMessage(chooser.reset() ? "Using the library identity again." : "This identity could not be reset.")}>Use library identity</Button>
    </section>}
    {chooser.resolution?.blockedReason && <p role="alert" className="metadata-edit-note">{chooser.resolution.blockedReason}</p>}
    <section className="metadata-edit-section space-y-3">
      <label className="metadata-edit-label">Search for an {identity.kind}
        <input className="metadata-edit-input" value={query} disabled={locked} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !locked && query.trim()) { e.preventDefault(); setMessage(null); void chooser.search("musicbrainz", query) } }} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" type="button" className="metadata-edit-button" disabled={locked || !query.trim()} onClick={() => { setMessage(null); void chooser.search("musicbrainz", query) }}>Search MusicBrainz</Button>
        {chooser.heyaAvailable && <Button variant="secondary" type="button" className="metadata-edit-button" disabled={locked || !query.trim()} onClick={() => { setMessage(null); void chooser.search("heya", query) }}>Search HeyaMetadata</Button>}
      </div>
    </section>
    {chooser.loading && <p role="status" className="metadata-edit-note">Verifying identities…</p>}
    {!!chooser.candidates.length && !chooser.reviewed && <div className="space-y-2" aria-label="Identity candidates">{chooser.candidates.map(candidate => <Button variant="bare" type="button" className="metadata-edit-section w-full text-left hover:bg-app-surface-hover" disabled={locked} key={`${candidate.provider}:${candidate.id}`} onClick={() => void chooser.review(candidate)}>
      <span className="block font-semibold">{candidate.title}</span>
      <span className="metadata-edit-note mt-1 block">{[candidate.kind === "album" ? candidate.artist : candidate.artistType, candidate.disambiguation, candidate.area, candidate.releaseDate].filter(Boolean).join(" · ") || sourceName(candidate)}</span>
      <span className="metadata-edit-note mt-2 block text-xs">Review this match →</span>
    </Button>)}</div>}
    {chooser.reviewed && <section className="metadata-edit-section">
      <h4 className="metadata-edit-section-title">Verified match</h4>
      <IdentityEvidence candidate={chooser.reviewed.candidate} />
      <p className="metadata-edit-note mt-4">Applying this match refreshes enrichment and artwork for this item in Hibiki.</p>
      <Button variant="primary" type="button" className="metadata-edit-button metadata-edit-button--primary mt-4" disabled={locked} onClick={() => setMessage(chooser.apply() ? "Identity applied in Hibiki." : "The identity changed. Review the match again.")}>Apply this identity</Button>
    </section>}
    {chooser.error && <p role="alert" className="metadata-edit-note">{chooser.error}</p>}
    <HeyaDiscoveryPanel identity={identity} disabled={disabled || chooser.loading} onReviewed={chooser.adoptReviewed} />
    {message && <p role="status" className="metadata-edit-note">{message}</p>}
  </div>
}
