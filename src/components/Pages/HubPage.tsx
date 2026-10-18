import { useMemo, useRef } from "react"
import { useLocation } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore } from "../../stores"
import { useProviderStore } from "../../stores/providerStore"
import { useUIStore } from "../../stores/uiStore"
import { useLibraryCollection } from "../../hooks/useLikedCollection"
import { useDiscoveryFeed, type DiscoveryCursor } from "../../hooks/useDiscoveryFeed"
import { browseYoutubeMusic, observeYoutubeMusicPages, useYoutubeMusicDiscovery } from "../../backends/ytmusic/discovery"
import { useYoutubeMusicHistory } from "../../backends/ytmusic/history"
import { sortLatestReleases, mergeDiscoveryItems, plexDiscoveryItems, youtubeDiscoveryItems, recentDiscoveryItems, isRecentlyPlayedHub, matchingYoutubeHubs } from "../../lib/discovery"
import { deduplicateAlbumItems } from "../../lib/dedup"
import type { MusicItem } from "../../types/music"
import { DiscoveryCard } from "../shared/DiscoveryCard"
import { DiscoveryMore } from "../shared/DiscoveryMore"
import { MediaGrid } from "../shared/MediaGrid"
import { PageRecovery } from "../shared/PageRecovery"
import { PageLoading } from "../shared/PageLoading"
import { useMusicAssociations } from "../../hooks/useMusicAssociations"
import { youtubeMusicItemMusic } from "../../backends/ytmusic/discovery"

export function HubPage({ hubId }: { hubId: string }) {
  const [, navigate] = useLocation()
  const provider = useProviderStore(state => state.provider)
  const refresh = useUIStore(state => state.pageRefreshKey)
  const openedAtRefresh = useRef(refresh)
  const deduplicate = useUIStore(state => state.deduplicateAlbums)
  const library = useLibraryStore(useShallow(state => ({ hubs: state.hubs, added: state.recentlyAdded, releases: state.latestReleases })))
  const collection = useLibraryCollection(hubId === "recently-added" ? "recent" : "hubs")
  const youtube = useYoutubeMusicDiscovery()
  const history = useYoutubeMusicHistory()
  const recent = hubId === "recently-played"
  const kind = hubId === "latest-releases" ? "latest" : hubId === "recently-added" ? "recent" : "hub"
  const hub = library.hubs.find(hub => recent ? isRecentlyPlayedHub(hub) : hub.identifier === hubId)
  const isYoutube = hubId.startsWith("ytmusic:")
  const remoteHubs = useMemo(() => !youtube.connected ? [] : youtube.hubs.filter(remote =>
    hubId === "latest-releases" ? remote.category === "releases" : recent ? remote.category === "recent"
      : isYoutube ? remote.id === hubId : hub ? matchingYoutubeHubs(hub, [remote]).length > 0 : false),
  [youtube.connected, youtube.hubs, hubId, recent, isYoutube, hub])
  const seeds: MusicItem[] = kind === "recent" ? library.added : kind === "latest"
    ? library.releases.map(item => ({ ...item, type: "album" as const })) : hub?.items ?? []
  const plexKey = isYoutube ? null : `${hubId}:${hub?.identifier ?? ""}:${hub?.key ?? ""}:${!!provider?.isOffline}:${refresh}:${!!hub || kind !== "hub"}`
  const plex = useDiscoveryFeed(provider, plexKey, seeds, item => `${item.type}:${item.id}`,
    !isYoutube && provider?.getDiscoveryPage && !provider.isOffline && (hub || kind !== "hub") ? async cursor => {
      const offset = typeof cursor === "number" ? cursor : 0
      const page = await provider.getDiscoveryPage!(kind, offset, 50, hub)
      const next = offset + page.items.length
      return { items: page.items, next: page.items.length && next < page.total ? next : undefined }
    } : null)
  const remoteSeeds = remoteHubs.flatMap(hub => hub.items)
  const preferred = remoteHubs.find(hub => hub.id === (recent ? "ytmusic:history" : "ytmusic:new-releases")) ?? remoteHubs[0]
  const destination = preferred?.destination ?? (preferred?.continuation ? { browseId: "FEmusic_home" } : null)
  const remoteKey = youtube.connected ? `${hubId}:${youtube.revision}:${remoteHubs.map(hub => hub.id).join(",")}:${refresh}` : null
  const remote = useDiscoveryFeed(youtube.revision, remoteKey, remoteSeeds, item => `${item.kind}:${item.id}`,
    destination ? async (cursor: DiscoveryCursor) => {
      if (!preferred?.destination && cursor === null) return { items: remoteSeeds, next: preferred?.continuation ?? undefined }
      const page = await browseYoutubeMusic(destination, typeof cursor === "string" ? cursor : null,
        cursor === null && refresh !== openedAtRefresh.current)
      return { items: page.items, next: page.continuation ?? undefined }
    } : null, destination ? receive => observeYoutubeMusicPages(destination, (cursor, page) => {
      const preview = !preferred?.destination && cursor === null ? page.hubs.filter(hub => remoteHubs.some(remote => remote.id === hub.id)) : null
      receive(cursor, { items: preview ? preview.flatMap(hub => hub.items) : page.items,
        next: preview ? preview.find(hub => hub.id === preferred?.id)?.continuation ?? undefined : page.continuation ?? undefined })
    }) : undefined)
  const local = recent && youtube.connected ? history : []
  const associations = useMusicAssociations(youtube.connected ? [...local, ...remote.items].map(youtubeMusicItemMusic) : [])
  const plexItems = deduplicate ? deduplicateAlbumItems(plex.items) : plex.items
  const merged = recent ? recentDiscoveryItems(plexItems, [...local, ...remote.items], associations)
    : mergeDiscoveryItems(plexDiscoveryItems(plexItems), youtube.connected ? youtubeDiscoveryItems(remote.items) : [], associations)
  const items = kind === "latest" ? sortLatestReleases(merged) : merged
  const anniversary = hub?.identifier.includes("anniversary")
  if (anniversary) items.sort((a, b) => {
    const year = (entry: typeof a) => entry.source === "plex" && "year" in entry.item ? entry.item.year : entry.source === "ytmusic" ? entry.item.year ?? 0 : 0
    return year(a) - year(b)
  })
  const title = hubId === "latest-releases" ? "Latest Releases" : hubId === "recently-added" ? "Recently Added"
    : recent ? "Recently Played Music" : hub?.title ?? remoteHubs[0]?.title ?? "Music collection"
  const loading = plex.loading || remote.loading || (isYoutube ? youtube.loading : collection.status === "loading")
  const error = plex.error || remote.error || (!items.length && !isYoutube && collection.status === "error")
  return (
    <div className="discovery-page space-y-6 pb-6">
      <header className="discovery-head"><div><h1 className="discovery-title">{title}</h1>
        <p className="discovery-subtitle">{kind === "latest" && youtube.connected ? "New releases from Plex and YouTube Music." : "Keep exploring your music."}</p></div></header>
      {!items.length && loading ? <PageLoading message="Loading music…" variant="grid" /> : !items.length ? (
        <PageRecovery kind={error ? "error" : "empty"} title={error ? "Could not load this collection" : isYoutube && !youtube.connected ? "Connect YouTube Music" : "No music in this collection"}
          description={isYoutube && !youtube.connected ? "Sign in with the YTM button to browse this collection." : "Try refreshing or browse another collection."}
          onRetry={() => { collection.retry(); void plex.loadMore(); void remote.loadMore() }} onReturnLibrary={() => navigate("/")} />
      ) : <MediaGrid>{items.map(entry => <DiscoveryCard key={`${entry.source}:${entry.item.id}`} entry={entry} showYear={anniversary} />)}</MediaGrid>}
      <DiscoveryMore more={plex.more || (youtube.connected && remote.more)} loading={plex.loading || remote.loading} error={plex.error || (youtube.connected && remote.error)}
        load={() => { void plex.loadMore(); if (youtube.connected) void remote.loadMore() }} />
    </div>
  )
}
