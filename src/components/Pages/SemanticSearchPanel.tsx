import { useEffect, useRef, useState } from "react"
import { Link, useLocation } from "wouter"
import { useSemanticDiscovery, searchSemantic } from "../../semantic/discovery"
import { useSemanticSettingsStore } from "../../semantic/store"
import type { SemanticMatch } from "../../semantic/types"
import { useProviderStore } from "../../stores/providerStore"

export function SemanticSearchPanel({ query }: { query: string }) {
  const index = useSemanticDiscovery()
  const enabled = useSemanticSettingsStore(s => s.enabled), installed = useSemanticSettingsStore(s => s.installed)
  const provider = useProviderStore(s => s.provider)
  const [, navigate] = useLocation()
  const version = useRef(0)
  const [results, setResults] = useState<SemanticMatch[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const request = ++version.current
    setResults([]); setError(null); setBusy(false)
    if (!enabled || !installed || !query.trim() || !index.scope || index.status !== "ready") return
    setBusy(true)
    const timer = setTimeout(() => {
      void searchSemantic(query).then(matches => {
        if (version.current === request && useProviderStore.getState().provider === provider) setResults(matches)
      }).catch(() => { if (version.current === request) setError("Local discovery could not complete this search. Try again after indexing saved pages.") })
        .finally(() => { if (version.current === request) setBusy(false) })
    }, 250)
    return () => { clearTimeout(timer); version.current++ }
  }, [query, enabled, installed, index.scope, index.status, index.indexed, provider])
  async function openTrack(match: SemanticMatch) {
    const owner = provider
    if (!owner) return
    const scope = owner.cacheScope, session = owner.playbackSession, request = version.current
    const current = () => version.current === request && useProviderStore.getState().provider === owner && owner.cacheScope === scope && owner.playbackSession === session
    try { const track = await owner.getTrack(match.id); if (!current()) return
      if (track.albumId) navigate(`/album/${track.albumId}`)
      else if (track.artistId) navigate(`/artist/${track.artistId}`)
      else setError("This saved track has no linked artist or album page.")
    } catch { if (current()) setError("The track’s page is not available. Reconnect to Plex and open it again.") }
  }
  return <section className="space-y-5" aria-label="Local semantic search">
    <div><h2 className="text-xl font-semibold">Find music by feeling</h2>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">Describe a mood, sound, or style. Local discovery compares saved descriptions, genres and moods.</p>
      <p className="mt-2 text-xs text-[var(--text-muted)]">{index.indexed} saved items · Results cover pages you have visited.</p></div>
    {(!enabled || !installed) ? <div className="rounded-xl border border-[var(--border)] bg-app-surface p-5">
      <p className="text-sm text-[var(--text-secondary)]">Enable the optional local model in Metadata settings to get started. Your music metadata stays on this device.</p>
      <Link href="/settings/metadata" className="mt-3 inline-flex rounded-full border border-[var(--border)] px-4 py-2 text-sm hover:bg-app-surface-hover">Open discovery settings</Link>
    </div> : <>
      {index.status === "loading" || index.status === "indexing" ? <p role="status" className="text-sm text-[var(--text-secondary)]">{index.status === "loading" ? "Loading the local model…" : `Indexing saved music… ${Math.round(index.progress * 100)}%`}</p> : !query.trim() ? <p className="text-sm text-[var(--text-secondary)]">Try “dreamy electronic music for a late night” or “heavy guitars with orchestral drama” in the search bar.</p> : busy ? <p role="status" className="text-sm text-[var(--text-secondary)]">Finding similar descriptions…</p> : index.indexed === 0 ? <p className="text-sm text-[var(--text-secondary)]">Visit some artist and album pages to save metadata for discovery.</p> : !results.length && !error && index.status === "ready" ? <p className="text-sm text-[var(--text-secondary)]">No saved matches yet. Try a broader description.</p> : null}
      {!!results.length && <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-app-surface/60">{results.map(match => {
        const contents = <><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-app-surface text-[var(--text-secondary)]" aria-hidden="true">{match.kind === "artist" ? "◌" : "♪"}</span><span className="min-w-0 flex-1"><span className="block truncate font-medium">{match.title}</span><span className="mt-1 block truncate text-sm text-[var(--text-secondary)]">{match.artist && match.artist !== match.title ? `${match.artist} · ` : ""}{match.kind}</span></span><span className="text-[var(--text-muted)]" aria-hidden="true">→</span></>
        const className = "flex w-full items-center gap-4 border-b border-[var(--border)] px-4 py-3 text-left last:border-0 hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        return match.kind === "track" ? <button type="button" key={`${match.kind}:${match.id}`} className={className} onClick={() => void openTrack(match)}>{contents}</button>
          : <Link key={`${match.kind}:${match.id}`} href={`/${match.kind}/${match.id}`} className={className}>{contents}</Link>
      })}</div>}
    </>}
    {(error || index.error) && <p role="alert" className="text-sm text-[var(--text-secondary)]">{error || index.error}</p>}
  </section>
}
