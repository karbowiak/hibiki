import { Button } from "../shared/Button"
import { useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import { Link } from "wouter"
import { useProviderStore } from "../../stores/providerStore"
import { usePlayerStore } from "../../stores/playerStore"
import { useWindowedPages } from "../../hooks/useWindowedPages"
import type { MusicItem, MusicTrack } from "../../types/music"
import type { WindowedCollection } from "../../lib/windowedPages"
import { MediaGrid } from "../shared/MediaGrid"
import { DiscoveryCard } from "../shared/DiscoveryCard"
import { DetailTrackList } from "../shared/TrackTable"

export type ServerLibraryKind = "artists" | "albums" | "songs"
const labels = { artists: "Artists", albums: "Albums", songs: "Songs" }

/** Full selected server catalogue. Favorites and the mixed library stay separate. */
export function ServerLibrary({ kind }: { kind: ServerLibraryKind }) {
  const provider = useProviderStore(state => state.provider)
  const pages = useWindowedPages<MusicItem>(provider ? `server-library:${kind}` : null, async (offset, limit) => {
    if (!provider) return { items: [], total: 0, offset }
    const method = kind === "artists" ? provider.getAllArtists : kind === "albums" ? provider.getAllAlbums : provider.getAllTracks
    if (!method) throw Error("This connection cannot browse the server library.")
    const page = await method.call(provider, offset, limit)
    const type = kind === "artists" ? "artist" : kind === "albums" ? "album" : "track"
    return { ...page, items: page.items.map(item => ({ ...item, type }) as MusicItem) }
  })
  const player = usePlayerStore(useShallow(state => ({ currentTrackId: state.currentTrack?.id, playPagedTracks: state.playPagedTracks,
    addToQueue: state.addToQueue, playRadio: state.playRadio })))
  const tracks = useMemo(() => pages.loadedItems.filter((item): item is MusicTrack & { type: "track" } => item.type === "track"), [pages, pages.snapshot()])
  const trackPages = pages as unknown as WindowedCollection<MusicTrack>
  return <div className="discovery-page space-y-6">
    <header className="discovery-head">
      <div><h1 className="discovery-title">{labels[kind]}</h1>
        <p className="discovery-subtitle">{provider?.isOffline ? "Saved server catalogue" : "Server Library"} · {pages.total.toLocaleString()} {kind}</p>
      </div>
    </header>
    <nav aria-label="Server Library" className="flex flex-wrap gap-2">
      {(Object.keys(labels) as ServerLibraryKind[]).map(value => <Link key={value} href={`/server-library/${value}`}
        aria-current={kind === value ? "page" : undefined} className={`discovery-pill ${kind === value ? "text-accent" : ""}`}>{labels[value]}</Link>)}
    </nav>
    {!provider ? <p role="status">Connect a Plex music library in Settings to browse the server.</p>
      : pages.loading && !pages.residentCount ? <p role="status">Loading {kind}…</p>
      : !pages.total && !pages.error ? <p role="status">No {kind} available{provider.isOffline ? " in the saved server catalogue" : " in this library"}.</p>
      : kind === "songs" ? <DetailTrackList tracks={tracks} paged={trackPages} currentTrackId={player.currentTrackId}
        onPlay={(track, _tracks, index) => {
          const selected = index ?? pages.loadedItems.findIndex(item => item.id === track.id)
          if (selected < 0) return
          void player.playPagedTracks({ key: `server-library:songs:${provider.cacheScope}`, total: pages.total,
            loadPage: (offset, limit) => provider.getAllTracks!(offset, limit) }, "Songs", "/server-library/songs", false, selected)
        }} onAddToQueue={player.addToQueue} onPlayRadio={player.playRadio} showRadio={!provider.isOffline} />
      : <MediaGrid paged={pages} renderItem={item => <DiscoveryCard entry={{ source: "plex", item }} showYear />} />}
    {pages.error && <p role="alert" className="text-sm text-(--text-secondary)">{pages.error} <Button variant="bare" type="button" className="underline" onClick={pages.retry}>Try again</Button></p>}
  </div>
}
