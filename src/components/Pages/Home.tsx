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
import type { MusicItem, MusicPlaylist, MusicTrack } from "../../types/music"
import type { MusicProvider } from "../../providers/types"
import type { DragPayload } from "../../stores/dragStore"
import { useContextMenu } from "../../hooks/useContextMenu"
import { makeOnPlay } from "../../lib/mediaPlay"
import { ScrollRow } from "../ScrollRow"
import { MediaCard } from "../MediaCard"
import { selectMix, shuffleTracks } from "./Mix"

function getItemYear(item: MusicItem): number {
  if (item.type === "album") return item.year
  if (item.type === "track") return item.year
  return 0
}

async function resolveItemsToTracks(items: MusicItem[], provider: MusicProvider): Promise<MusicTrack[]> {
  const results = await Promise.all(items.map(async (item) => {
    switch (item.type) {
      case "track": return [item as MusicTrack]
      case "album": return provider.getAlbumTracks(item.id)
      case "artist": return provider.getArtistPopularTracks(item.id, 10)
      case "playlist": return provider.getPlaylistItems(item.id, 0, 100).then(r => r.items)
      default: return []
    }
  }))
  return results.flat()
}

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

export function getMediaInfo(item: MusicItem, opts?: { showYear?: boolean }) {
  switch (item.type) {
    case "album":
      return {
        title: item.title,
        desc: opts?.showYear && item.year > 0
          ? `${item.artistName} · ${item.year}`
          : item.artistName,
        thumb: item.thumbUrl,
        isArtist: false,
        href: `/album/${item.id}`,
        id: item.id,
        itemType: "album" as const,
        artistName: item.artistName,
        albumName: item.title,
      }
    case "artist":
      return {
        title: item.title,
        desc: "Artist",
        thumb: item.thumbUrl,
        isArtist: true,
        href: `/artist/${item.id}`,
        id: item.id,
        itemType: "artist" as const,
        artistName: item.title,
        albumName: null,
      }
    case "track":
      return {
        title: item.title,
        desc: opts?.showYear && item.year > 0
          ? `${item.artistName} · ${item.year}`
          : item.artistName,
        thumb: item.thumbUrl,
        isArtist: false,
        href: item.albumId ? `/album/${item.albumId}` : null,
        id: item.id,
        itemType: "track" as const,
        artistName: item.artistName,
        albumName: item.albumName,
      }
    case "playlist":
      return {
        title: item.title,
        desc: "Playlist",
        thumb: item.thumbUrl,
        isArtist: false,
        href: `/playlist/${item.id}`,
        id: item.id,
        itemType: "playlist" as const,
      }
    default:
      return null
  }
}

/** Build a drag payload for any media item (track, album, artist). */
export function makeDragPayload(item: MusicItem): DragPayload | undefined {
  switch (item.type) {
    case "track":
      return { type: "track", ids: [item.id], label: item.title, tracks: [item as MusicTrack] }
    case "album":
      return { type: "album", ids: [item.id], label: item.title }
    case "artist":
      return { type: "artist", ids: [item.id], label: item.title }
    default:
      return undefined
  }
}

export function Home() {
  // Granular selector: only re-render when recentlyAdded or hubs actually change.
  // Changes to playlistItemsCache (from background prefetch) do NOT trigger re-renders here.
  const { recentlyAdded, hubs } = useLibraryStore(
    useShallow((s) => ({
      recentlyAdded: s.recentlyAdded,
      hubs: s.hubs,
    }))
  )
  const { isConnected, isLoading: isConnecting } = useConnectionStore(
    useShallow((s) => ({ isConnected: s.isConnected, isLoading: s.isLoading }))
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

  const hasRealData = recentlyAdded.length > 0 || hubs.length > 0

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
    const current = () =>
      view.active &&
      view.revision === revision &&
      useProviderStore.getState().provider === provider
    setPlayError(false)
    void (async () => {
      try {
        const items = await load()
        if (!current() || !items.length) return
        const tracks = shuffle ? shuffleArray(items) : items
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
        : "Not connected. Go to Settings to connect."
    return (
      <div className="space-y-8">
        <div className="text-sm text-gray-400">{message}</div>
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
    <div className="space-y-6 pb-4">
      {playError && <p role="alert" className="text-sm text-red-400">Could not play these items. Please try again.</p>}
      {mixesItems.length > 0 && (
        <ScrollRow title={mixesTitle} titleHref="/stations" restoreKey="home-mixes">
          {mixesItems.map((item, idx) => {
            if (item.type !== "playlist") return null
            const thumb = mixThumbs[mixThumbnailKey(item)] ?? item.thumbUrl
            return (
              <MediaCard
                key={`${item.id}-${idx}`}
                title={item.title}
                desc="Mix for You"
                thumb={thumb}
                isArtist
                artistName={mixTitleToArtistName(item.title)}
                onClick={() => {
                  selectMix(item as MusicPlaylist)
                  navigate("/mix")
                }}
                onPlay={() => {
                  const mixKey = item.providerKey as string | undefined
                  if (!mixKey || !provider?.getMixTracks) return
                  playResolved(async () => shuffleTracks(await provider.getMixTracks!(mixKey), item.title), item.title, "/mix", false)
                }}
                scrollItem
                large
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
