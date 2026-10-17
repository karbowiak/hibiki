import { MusicSourceBadge } from "../shared/MusicSource"
import { getMediaInfo, makeDragPayload } from "../../lib/mediaCardInfo"
import { deduplicateAlbums, deduplicateAlbumItems, deduplicateHubAlbums } from "../../lib/dedup"
import { useUIStore } from "../../stores/uiStore"
import { loadAlbumTracks } from "../../lib/albumContents"
import {
  mixTitleToArtistName,
  mixThumbnailKey,
  useMixThumbnails,
} from "../../hooks/useMixThumbnails"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useLocation } from "wouter"
import {
  useLibraryStore,
  useConnectionStore,
  usePlayerStore,
} from "../../stores"
import { useProviderStore } from "../../stores/providerStore"
import { prefetchArtist, prefetchAlbum } from "../../stores/metadataCache"
import type { MusicItem, MusicTrack } from "../../types/music"
import type { MusicProvider } from "../../providers/types"
import { useContextMenu } from "../../hooks/useContextMenu"
import { makeOnPlay } from "../../lib/mediaPlay"
import { ScrollRow } from "../ScrollRow"
import { MediaCard } from "../MediaCard"
import { selectMix } from "../../lib/mixSelection"
import { mixPlaybackSource, orderMixTracks } from "../../lib/mixOrder"
import { Link } from "wouter"
import "../../styles/discovery.css"
import { PageLoading } from "../shared/PageLoading"
import { DiscoveryCard } from "../shared/DiscoveryCard"
import { useYoutubeMusicDiscovery, browseYoutubeMusic, youtubeMusicItemTrack } from "../../backends/ytmusic/discovery"
import { useYoutubeMusicHistory } from "../../backends/ytmusic/history"
import { homeDiscoverySections, mixDiscoveryItems, sortLatestReleases, isRecentlyPlayedHub, mergeDiscoveryItems, plexDiscoveryItems, youtubeDiscoveryItems, recentDiscoveryItems, type DiscoveryItem } from "../../lib/discovery"
import { advancePlaybackSelection, capturePlaybackSelectionVersion } from "../../lib/playbackSelection"
import { shuffled } from "../../lib/pagedPlayback"

async function resolveItemsToTracks(items: MusicItem[], provider: MusicProvider): Promise<MusicTrack[]> {
  const results = await Promise.all(items.map(async (item) => {
    switch (item.type) {
      case "track": return [item as MusicTrack]
      case "album": return loadAlbumTracks(provider,item.id)
      case "artist": return provider.getArtistPopularTracks(item.id, 10)
      case "playlist": return provider.getPlaylistItems(item.id, 0, 100).then(r => r.items)
      default: return []
    }
  }))
  return results.flat()
}

async function resolveDiscoveryTracks(items: DiscoveryItem[], provider: MusicProvider): Promise<MusicTrack[]> {
  const results: MusicTrack[][] = new Array(items.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (index < items.length) {
      const current = index++, entry = items[current]
      results[current] = entry.source === "plex" ? await resolveItemsToTracks([entry.item], provider)
        : entry.item.kind === "song" ? [youtubeMusicItemTrack(entry.item)]
          : (await browseYoutubeMusic({ browseId: entry.item.id })).items.filter(item => item.kind === "song").map(youtubeMusicItemTrack)
    }
  }))
  return results.flat()
}

export function Home() {
  const youtube = useYoutubeMusicDiscovery(true)
  const history = useYoutubeMusicHistory()
  // Granular selector: only re-render when recentlyAdded or hubs actually change.
  // Changes to playlistItemsCache (from background prefetch) do NOT trigger re-renders here.
  const { recentlyAdded: rawAdded, latestReleases: rawReleases, hubs: rawHubs } = useLibraryStore(
    useShallow((s) => ({
      recentlyAdded: s.recentlyAdded,
      latestReleases: s.latestReleases,
      hubs: s.hubs,
    }))
  )
  const shouldDeduplicate = useUIStore(s=>s.deduplicateAlbums)
  const recentlyAdded=useMemo(()=>shouldDeduplicate ? deduplicateAlbumItems(rawAdded) : rawAdded,[rawAdded,shouldDeduplicate])
  const latestReleases=useMemo(()=>shouldDeduplicate ? deduplicateAlbums(rawReleases) : rawReleases,[rawReleases,shouldDeduplicate])
  const hubs=useMemo(()=>shouldDeduplicate ? rawHubs.map(deduplicateHubAlbums) : rawHubs,[rawHubs,shouldDeduplicate])
  const { isConnected, isOffline, isLoading: isConnecting } = useConnectionStore(
    useShallow((s) => ({ isConnected: s.isConnected, isOffline: s.isOffline, isLoading: s.isLoading }))
  )
  const provider = useProviderStore((s) => s.provider)
  const { playFromUri, playTrack, playPlaylist } = usePlayerStore(
    useShallow((s) => ({
      playFromUri: s.playFromUri,
      playTrack: s.playTrack,
      playPlaylist: s.playPlaylist,
    }))
  )
  const [, navigate] = useLocation()
  const { handler: ctxMenu } = useContextMenu()

  function makeOnContextMenu(item: MusicItem) {
    if (
      item.type === "album" ||
      item.type === "artist" ||
      item.type === "track"
    )
      return ctxMenu(item.type, item)
    return undefined
  }

  const hasRealData = latestReleases.length > 0 || recentlyAdded.length > 0 || hubs.length > 0 || youtube.hubs.length > 0
  const latestReleaseItems = useMemo(
    () => latestReleases.slice(0, 30).map(album => ({ ...album, type: "album" as const })),
    [latestReleases]
  )

  const { mixesItems, mixesTitle } = useMemo(() => {
    const mh = hubs.filter((h) => h.identifier?.startsWith("music.mixes"))
    return {
      mixesItems: mh.flatMap((h) => h.items),
      mixesTitle: mh[0]?.title ?? "Mixes for You",
    }
  }, [hubs])

  const mixedReleases = useMemo(() => sortLatestReleases(mergeDiscoveryItems(plexDiscoveryItems(latestReleaseItems),
    youtube.connected ? youtubeDiscoveryItems(youtube.hubs.filter(hub => hub.category === "releases").flatMap(hub => hub.items)) : [])).slice(0, 30), [latestReleaseItems, youtube.connected, youtube.hubs])
  const mixedMixes = useMemo(() => mixDiscoveryItems(mixesItems, youtube.connected ? youtube.hubs : []), [mixesItems, youtube.connected, youtube.hubs])
  const recentItems = useMemo(() => recentDiscoveryItems(hubs.filter(isRecentlyPlayedHub).flatMap(hub => hub.items),
    youtube.connected ? [...history, ...youtube.hubs.filter(hub => hub.category === "recent").flatMap(hub => hub.items)] : []).slice(0, 30), [hubs, youtube.connected, youtube.hubs, history])
  const otherSections = useMemo(() => homeDiscoverySections(hubs.filter(hub => hub.items.length > 0 && hub.identifier
    && !hub.identifier.startsWith("music.mixes") && !isRecentlyPlayedHub(hub)
    && !/recently[. ]?added|station/i.test(`${hub.identifier} ${hub.title}`)), youtube.connected ? youtube.hubs : []), [hubs, youtube.connected, youtube.hubs])

  const mixThumbs = useMixThumbnails(provider, mixesItems)
  const playbackView = useRef({ active: false, revision: 0 })
  const [playError, setPlayError] = useState(false)
  useLayoutEffect(() => {
    const view = { active: true, revision: 0 }
    playbackView.current = view
    setPlayError(false)
    return () => {
      view.active = false
    }
  }, [provider])
  function playResolved(
    load: () => Promise<MusicTrack[]>,
    title: string,
    route: string | null,
    shuffle: boolean
  ) {
    const view = playbackView.current
    const revision = ++view.revision
    const selection = advancePlaybackSelection()
    const current = () =>
      view.active &&
      capturePlaybackSelectionVersion() === selection &&
      view.revision === revision &&
      useProviderStore.getState().provider === provider
    setPlayError(false)
    void (async () => {
      try {
        const items = await load()
        if (!current() || !items.length) return
        const tracks = shuffle ? shuffled(items) : items
        await playTrack(tracks[0], tracks, title, route)
      } catch {
        if (current()) setPlayError(true)
      }
    })()
  }

  if (!hasRealData) {
    const message = isConnecting
      ? "Connecting…"
      : isConnected
        ? "Loading your library…"
        : isOffline
          ? "There is no saved home page for this library. Previously saved artists, albums and playlists are still available."
          : "Not connected. Go to Settings to connect."
    if (isConnecting || isConnected) {
      return <PageLoading message={message} variant="home" />
    }
    return (
      <div className="mx-auto max-w-lg space-y-3 rounded-xl border border-(--border) bg-app-card px-6 py-8 text-center">
        <h1 className="text-xl font-semibold">{isOffline ? "Your saved library" : "Connect your music library"}</h1>
        <p className="text-sm text-(--text-secondary)">{message}</p>
        <button
          onClick={() => navigate("/settings")}
          className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-black"
        >
          Open Settings
        </button>
        {isOffline && (
          <button onClick={() => navigate("/library")} className="ml-2 rounded-full border border-(--border) px-4 py-2 text-sm">
            Browse saved library
          </button>
        )}
      </div>
    )
  }

  function makePrefetch(info: ReturnType<typeof getMediaInfo>) {
    if (!info) return undefined
    if (info.itemType === "artist") return () => prefetchArtist(info.id)
    if (info.itemType === "album") return () => prefetchAlbum(info.id)
    return undefined
  }

  return (
    <div className="discovery-page space-y-6 pb-4">
      <header className="discovery-head">
        <div>
          <h1 className="discovery-title">
            {new Date().getHours() < 12
              ? "Good morning"
              : new Date().getHours() < 18
                ? "Good afternoon"
                : "Good evening"}
          </h1>
          <p className="discovery-subtitle">
            A familiar favorite, a new release, or something made for you.
          </p>
        </div>
        <div className="discovery-tools">
          <Link href="/library" className="discovery-pill">
            Your Library <span aria-hidden="true">↗</span>
          </Link>
          {provider?.capabilities.stations && (
            <Link href="/stations" className="discovery-pill">
              Explore Stations
            </Link>
          )}
        </div>
      </header>
      {playError && <p role="alert" className="text-sm text-red-400">Could not play these items. Please try again.</p>}
      {mixedMixes.length > 0 && (
        <ScrollRow title={mixesTitle} titleHref="/stations" restoreKey="home-mixes">
          {mixedMixes.map((entry) => {
            if (entry.source === "ytmusic") return <DiscoveryCard key={`ytmusic:${entry.item.id}`} entry={entry} scrollItem large mix />
            const item = entry.item
            if (item.type !== "playlist") return null
            const thumb = mixThumbs[mixThumbnailKey(item)] ?? item.thumbUrl
            const openMix = () => { selectMix(item); navigate("/mix") }
            const playMix = () => {
              const mixKey = item.providerKey
              if (!mixKey || !provider?.getMixTracks) return
              if (provider.getMixTracksPage) {
                void usePlayerStore.getState().playPagedTracks(mixPlaybackSource(provider, mixKey), item.title, "/mix")
                return
              }
              playResolved(async () => orderMixTracks(await provider.getMixTracks!(mixKey)), item.title, "/mix", false)
            }
            return (
              <MediaCard
                key={mixThumbnailKey(item)}
                title={item.title}
                desc="Mix for You"
                artworkBadge={<MusicSourceBadge source="plex" />}
                thumb={thumb}
                isArtist
                artistName={mixTitleToArtistName(item.title)}
                onClick={openMix}
                onPlay={playMix}
                contextActions={[
                  { label: "Open mix", run: openMix },
                  ...(provider?.getMixTracks && item.providerKey ? [{ label: "Play mix", run: playMix }] : []),
                ]}
                scrollItem
                large
              />
            )
          })}
        </ScrollRow>
      )}

      {mixedReleases.length > 0 && (
        <ScrollRow
          title="Latest Releases"
          titleHref="/hub/latest-releases"
          restoreKey="home-latest-releases"
          onPlayAll={provider ? () => playResolved(() => resolveDiscoveryTracks(mixedReleases, provider), "Latest Releases", null, false) : undefined}
          onShuffleAll={provider ? () => playResolved(() => resolveDiscoveryTracks(mixedReleases, provider), "Latest Releases", null, true) : undefined}
        >
          {mixedReleases.map(entry => <DiscoveryCard key={`${entry.source}:${entry.item.id}`} entry={entry} scrollItem />)}
        </ScrollRow>
      )}

      {recentlyAdded.length > 0 && (
        <ScrollRow
          title="Recently Added"
          titleHref="/recently-added"
          restoreKey="home-recently-added"
          onPlayAll={provider ? () => playResolved(() => resolveItemsToTracks(recentlyAdded.slice(0, 30), provider), "Recently Added", null, false) : undefined}
          onShuffleAll={provider ? () => playResolved(() => resolveItemsToTracks(recentlyAdded.slice(0, 30), provider), "Recently Added", null, true) : undefined}
        >
          {recentlyAdded.slice(0, 30).map((item, idx) => {
            const info = getMediaInfo(item)
            if (!info) return null
            const Card = MediaCard
            return (
              <Card
                key={`${item.id}-${idx}`}
                title={info.title}
                desc={info.desc}
                thumb={info.thumb}
                isArtist={info.isArtist}
                href={info.href ?? undefined}
                prefetch={makePrefetch(info)}
                onPlay={makeOnPlay(item, { playTrack, playFromUri, playPlaylist, provider })}
                onContextMenu={makeOnContextMenu(item)}
                dragPayload={makeDragPayload(item)}
                artistName={"artistName" in info ? info.artistName : undefined}
                albumName={"albumName" in info ? info.albumName : undefined}
                scrollItem
              />
            )
          })}
        </ScrollRow>
      )}

      {recentItems.length > 0 && <ScrollRow title="Recently Played Music" titleHref="/hub/recently-played" restoreKey="home-recently-played"
        onPlayAll={provider ? () => playResolved(() => resolveDiscoveryTracks(recentItems, provider), "Recently Played Music", "/hub/recently-played", false) : undefined}
        onShuffleAll={provider ? () => playResolved(() => resolveDiscoveryTracks(recentItems, provider), "Recently Played Music", "/hub/recently-played", true) : undefined}>
        {recentItems.map(entry => <DiscoveryCard key={`${entry.source}:${entry.item.id}`} entry={entry} scrollItem />)}
      </ScrollRow>}

      {otherSections.map(section => {
        const original = hubs.find(hub => hub.identifier === section.id)
        const anniversary = section.id.includes("anniversary")
        const items = anniversary ? [...section.items].sort((a, b) => {
          const year = (entry: DiscoveryItem) => entry.source === "plex" && "year" in entry.item ? entry.item.year : entry.source === "ytmusic" ? entry.item.year ?? 0 : 0
          return year(a) - year(b)
        }) : section.items
        if (original?.layout === "pills") return <section key={section.id}>
          <h2 className="mb-3 text-base font-semibold"><Link href={section.href} className="hover:underline">{section.title}</Link></h2>
          <div className="flex flex-wrap gap-2">{items.slice(0, 30).map(entry => {
            if (entry.source !== "plex") return null
            const info = getMediaInfo(entry.item)
            return info?.href ? <Link key={entry.item.id} href={info.href} className="rounded-full bg-app-surface px-4 py-1.5 text-sm text-(--text-secondary) hover:bg-app-surface-hover">{info.title}</Link> : null
          })}</div>
        </section>
        return <ScrollRow key={section.id} title={section.title} titleHref={section.href} restoreKey={`home-hub-${section.id}`}
          onPlayAll={provider ? () => playResolved(() => resolveDiscoveryTracks(items.slice(0, 30), provider), section.title, section.href, false) : undefined}
          onShuffleAll={provider ? () => playResolved(() => resolveDiscoveryTracks(items.slice(0, 30), provider), section.title, section.href, true) : undefined}>
          {items.slice(0, 30).map(entry => <DiscoveryCard key={`${entry.source}:${entry.item.id}`} entry={entry} showYear={anniversary} scrollItem large={original?.layout === "hero"} />)}
        </ScrollRow>
      })}
    </div>
  )
}
