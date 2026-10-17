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
import { advancePlaybackSelection, capturePlaybackSelectionVersion } from "../../lib/playbackSelection"
import { shuffled } from "../../lib/pagedPlayback"

function getItemYear(item: MusicItem): number {
  if (item.type === "album") return item.year
  if (item.type === "track") return item.year
  return 0
}

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

export function Home() {
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

  const hasRealData = latestReleases.length > 0 || recentlyAdded.length > 0 || hubs.length > 0
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
      {mixesItems.length > 0 && (
        <ScrollRow title={mixesTitle} titleHref="/stations" restoreKey="home-mixes">
          {mixesItems.map((item) => {
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

      {latestReleaseItems.length > 0 && (
        <ScrollRow
          title="Latest Releases"
          restoreKey="home-latest-releases"
          onPlayAll={provider ? () => playResolved(() => resolveItemsToTracks(latestReleaseItems, provider), "Latest Releases", null, false) : undefined}
          onShuffleAll={provider ? () => playResolved(() => resolveItemsToTracks(latestReleaseItems, provider), "Latest Releases", null, true) : undefined}
        >
          {latestReleaseItems.map((item, idx) => {
            const info = getMediaInfo(item)
            if (!info) return null
            return (
              <MediaCard
                key={`${item.id}-${idx}`}
                title={info.title}
                desc={info.desc}
                thumb={info.thumb}
                isArtist={false}
                href={info.href ?? undefined}
                prefetch={makePrefetch(info)}
                onPlay={makeOnPlay(item, { playTrack, playFromUri, playPlaylist, provider })}
                onContextMenu={makeOnContextMenu(item)}
                dragPayload={makeDragPayload(item)}
                artistName={item.artistName}
                albumName={item.title}
                scrollItem
              />
            )
          })}
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

      {hubs.map(hub => {
        if (hub.items.length === 0 || !hub.identifier) return null
        // Skip mixes hubs — already rendered as the pinned top section
        if (hub.identifier.startsWith("music.mixes")) return null
        // Skip recently-added hubs — identifier-based + title fallback for server-variant identifiers
        if (hub.identifier.toLowerCase().includes("recently.added") ||
            hub.identifier.toLowerCase().includes("recentlyadded") ||
            hub.title.toLowerCase().startsWith("recently added")) return null
        // Skip station hubs — already shown on the /stations page
        if (hub.identifier.toLowerCase().includes("station")) return null
        const isAnniversary = hub.identifier.includes("anniversary")
        // "On This Day" — sort oldest → newest and show the release year.
        const items = isAnniversary
          ? [...hub.items].sort((a, b) => getItemYear(a) - getItemYear(b))
          : hub.items
        const layout = hub.layout ?? "scroller"

        // Pills layout — flex-wrap of rounded pill buttons
        if (layout === "pills") {
          return (
            <div key={hub.identifier}>
              <h2 className="text-base font-semibold text-white mb-3">{hub.title}</h2>
              <div className="flex flex-wrap gap-2">
                {items.slice(0, 30).map((item, idx) => {
                  const info = getMediaInfo(item)
                  if (!info) return null
                  return (
                    <button
                      key={`${item.id}-${idx}`}
                      onClick={() => info.href && navigate(info.href)}
                      className="rounded-full bg-white/10 px-4 py-1.5 text-sm text-white/70 hover:bg-white/20 hover:text-white transition-colors"
                    >
                      {info.title}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        }

        // Hero layout — larger cards with image overlay
        if (layout === "hero") {
          return (
            <ScrollRow
              key={hub.identifier}
              title={hub.title}
              titleHref={"/hub/" + encodeURIComponent(hub.identifier)}
              restoreKey={`home-hub-${hub.identifier}`}
              onPlayAll={provider ? () => playResolved(() => resolveItemsToTracks(items.slice(0, 30), provider), hub.title, null, false) : undefined}
              onShuffleAll={provider ? () => playResolved(() => resolveItemsToTracks(items.slice(0, 30), provider), hub.title, null, true) : undefined}
            >
              {items.slice(0, 30).map((item, idx) => {
                const info = getMediaInfo(item, { showYear: isAnniversary })
                if (!info) return null
                return (
                  <MediaCard
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
                    scrollItem
                    large
                  />
                )
              })}
            </ScrollRow>
          )
        }

        // Default scroller layout
        return (
          <ScrollRow
            key={hub.identifier}
            title={hub.title}
            titleHref={"/hub/" + encodeURIComponent(hub.identifier)}
            restoreKey={`home-hub-${hub.identifier}`}
            onPlayAll={provider ? () => playResolved(() => resolveItemsToTracks(items.slice(0, 30), provider), hub.title, null, false) : undefined}
            onShuffleAll={provider ? () => playResolved(() => resolveItemsToTracks(items.slice(0, 30), provider), hub.title, null, true) : undefined}
          >
            {items.slice(0, 30).map((item, idx) => {
              const info = getMediaInfo(item, { showYear: isAnniversary })
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
        )
      })}
    </div>
  )
}
