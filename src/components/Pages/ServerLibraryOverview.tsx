import { useEffect, useState } from "react"
import { Link } from "wouter"
import { IconDisc, IconMicrophone, IconMusic } from "@tabler/icons-react"
import { useProviderOwner } from "../../hooks/useProviderOwner"
import { useUIStore } from "../../stores/uiStore"
import { useConnectionStore } from "../../stores/connectionStore"
import { loadServerOverview, type ServerOverviewSection } from "../../lib/serverLibraryOverview"
import { DiscoveryCard } from "../shared/DiscoveryCard"
import { ScrollRow } from "../ScrollRow"
import { Button } from "../shared/Button"
import "../../styles/discovery.css"

export function ServerLibraryOverview() {
  const { provider, session, scope } = useProviderOwner()
  const library = useConnectionStore(state => state.musicSectionTitle)
  const baseUrl = useConnectionStore(state => state.baseUrl)
  const refresh = useUIStore(state => state.pageRefreshKey)
  const [retry, setRetry] = useState(0)
  const [saved, setSaved] = useState<{ provider: typeof provider; session: unknown; scope: typeof scope; sections: ServerOverviewSection[] } | null>(null)
  useEffect(() => {
    let retired = false
    setSaved(null)
    if (provider) void loadServerOverview(provider).then(sections => {
      if (!retired) setSaved({ provider, session, scope, sections })
    })
    return () => { retired = true }
  }, [provider, session, scope, refresh, retry])
  const sections = saved?.provider === provider && saved?.session === session && saved?.scope === scope ? saved?.sections : undefined
  let server = "Plex server"
  try { server = new URL(baseUrl).hostname } catch {}
  return <div className="discovery-page space-y-8">
    <header className="discovery-head"><div>
      <h1 className="discovery-title">Server Library</h1>
      <p className="discovery-subtitle">{library ?? "Music library"} · {server}</p>
      {provider?.isOffline && <p role="status" className="mt-2 text-sm text-(--text-secondary)">Offline · showing saved catalogue coverage. Reconnect to browse the complete library.</p>}
    </div></header>
    <nav aria-label="Server library categories" className="discovery-overview">
      {[{ kind: "artists", title: "Artists", desc: "Explore the artists on your server", icon: IconMicrophone },
        { kind: "albums", title: "Albums", desc: "Albums, singles and EPs", icon: IconDisc },
        { kind: "songs", title: "Songs", desc: "Browse the full song catalogue", icon: IconMusic }].map(({ kind, title, desc, icon: Icon }) =>
        <Link key={kind} href={`/server-library/${kind}`} className="discovery-overview-card">
          <span className="discovery-overview-icon"><Icon size={20} aria-hidden="true" /></span>
          <span className="min-w-0 flex-1"><strong>{title}</strong><small>{desc}</small></span><span aria-hidden="true">↗</span>
        </Link>)}
    </nav>
    {!provider ? <p role="status">Connect a Plex music library in Settings to browse your server.</p>
      : !sections ? <p role="status" className="text-sm text-(--text-secondary)">Loading your server library…</p>
      : <>
        <dl className="discovery-ledger" aria-label={provider.isOffline ? "Saved library coverage" : "Server library totals"}>
          {sections.map(({ kind, page }) => <div key={kind}><dt>{kind === "albums" ? "Releases" : kind === "songs" ? "Songs" : "Artists"}{provider.isOffline ? " saved" : ""}</dt>
            <dd>{page ? page.total.toLocaleString() : "—"}</dd>
            {provider.isOffline && page?.serverTotal != null && <small className="text-(--text-secondary)">of {page.serverTotal.toLocaleString()} on server{page.localCoverageComplete === false ? " · partial" : ""}</small>}
          </div>)}
        </dl>
        {sections.every(section => section.page?.total === 0) && <p role="status">{provider.isOffline ? "No saved music is available yet. Reconnect to browse this library." : "This music library is empty."}</p>}
        {sections.map(section => <section key={section.kind}>
          {section.page && section.page.items.length > 0 && <ScrollRow title={provider.isOffline ? `Saved ${section.kind === "albums" ? "releases" : section.kind}` : section.title}
            titleHref={`/server-library/${section.kind}`} restoreKey={`server-overview:${scope}:${section.kind}`}>
            {section.page.items.map(item => <DiscoveryCard key={`${item.type}:${item.id}`} entry={{ source: "plex", item }} scrollItem showYear />)}
          </ScrollRow>}
          {section.error && <p role="alert" className="text-sm text-(--text-secondary)">{section.kind === "albums" ? "Releases" : section.kind === "artists" ? "Artists" : "Songs"}: {section.error}</p>}
        </section>)}
        {sections.some(section => section.error) && <Button onClick={() => setRetry(value => value + 1)}>Try again</Button>}
      </>}
  </div>
}
