import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { Link, useLocation } from "wouter"
import { useShallow } from "zustand/shallow"
import { useLibraryStore } from "../../stores/libraryStore"
import { useProviderStore } from "../../stores/providerStore"
import {
  capturePlaybackSelectionVersion,
  usePlayerStore,
} from "../../stores/playerStore"
import { selectSearchDiscovery } from "../../lib/searchDiscovery"
import { makeOnPlay } from "../../lib/mediaPlay"
import {
  mixThumbnailKey,
  mixTitleToArtistName,
  useMixThumbnails,
} from "../../hooks/useMixThumbnails"
import { useContextMenu } from "../../hooks/useContextMenu"
import { prefetchAlbum, prefetchArtist } from "../../stores/metadataCache"
import type { MusicItem, MusicPlaylist } from "../../types/music"
import { MediaGrid } from "../shared/MediaGrid"
import { MediaCard } from "../MediaCard"
import { getMediaInfo, makeDragPayload } from "./Home"
import { selectMix, shuffleTracks } from "./Mix"

function RecentTile({
  item,
  onPlay,
}: {
  item: MusicItem
  onPlay?: () => void
}) {
  const info = getMediaInfo(item)!
  return <MediaCard title={info.title} desc={info.desc} thumb={info.thumb}
    isArtist={info.isArtist} artistName={info.artistName} albumName={info.albumName}
    href={info.href ?? undefined} onClick={!info.href ? onPlay : undefined}
    onPlay={onPlay} contextItem={item} dragPayload={makeDragPayload(item)}
    prefetch={info.itemType === "artist" ? () => prefetchArtist(info.id) : info.itemType === "album" ? () => prefetchAlbum(info.id) : undefined} />
}

export function SearchDiscovery() {
  const [, navigate] = useLocation()
  const hubs = useLibraryStore((s) => s.hubs)
  const provider = useProviderStore((s) => s.provider)
  const playback = usePlayerStore(
    useShallow((s) => ({
      playTrack: s.playTrack,
      playFromUri: s.playFromUri,
      playPlaylist: s.playPlaylist,
    }))
  )
  const selected = useMemo(() => {
    const discovery = selectSearchDiscovery(provider ? hubs : [])
    if (!provider?.capabilities.mixTracks) discovery.mixes = []
    return discovery
  }, [hubs, provider])
  const mixThumbs = useMixThumbnails(provider, selected.mixes)
  const { handler: context } = useContextMenu()
  const scope = provider?.cacheScope
  const lifecycle = useRef({ active: false, revision: 0 })
  const [playError, setPlayError] = useState(false)
  useLayoutEffect(() => {
    const view = { active: true, revision: 0 }
    lifecycle.current = view
    setPlayError(false)
    return () => {
      view.active = false
    }
  }, [provider, scope])
  const currentProvider = () =>
    useProviderStore.getState().provider === provider &&
    provider?.cacheScope === scope
  function playMix(item: MusicPlaylist) {
    if (!currentProvider() || !provider?.getMixTracks || !item.providerKey)
      return
    const view = lifecycle.current
    const revision = ++view.revision
    let selection = capturePlaybackSelectionVersion()
    const current = () =>
      view.active &&
      revision === view.revision &&
      currentProvider() &&
      selection === capturePlaybackSelectionVersion()
    setPlayError(false)
    void (async () => {
      try {
        const tracks = shuffleTracks(
          await provider.getMixTracks!(item.providerKey!),
          item.title
        )
        if (!current()) return
        if (!tracks.length) {
          setPlayError(true)
          return
        }
        const playing = playback.playTrack(
          tracks[0],
          tracks,
          item.title,
          "/mix"
        )
        selection = capturePlaybackSelectionVersion()
        await playing
      } catch {
        if (current()) setPlayError(true)
      }
    })()
  }
  function card(item: MusicItem, mix = false) {
    const info = getMediaInfo(item)
    if (!info) return null
    return (
      <MediaCard
        key={
          mix && item.type === "playlist"
            ? mixThumbnailKey(item)
            : `${item.type}:${item.id}`
        }
        title={info.title}
        desc={mix ? "Mix for You" : info.desc}
        thumb={
          mix && item.type === "playlist"
            ? (mixThumbs[mixThumbnailKey(item)] ?? item.thumbUrl)
            : info.thumb
        }
        isArtist={mix || info.isArtist}
        artistName={mix ? mixTitleToArtistName(item.title) : info.artistName}
        albumName={info.albumName}
        href={mix ? "/mix" : (info.href ?? undefined)}
        onClick={
          mix
            ? () => {
                if (currentProvider()) selectMix(item as MusicPlaylist)
              }
            : undefined
        }
        onPlay={
          mix
            ? provider?.getMixTracks &&
              item.type === "playlist" &&
              item.providerKey
              ? () => playMix(item)
              : undefined
            : makeOnPlay(item, { ...playback, provider })
        }
        prefetch={
          info.itemType === "artist"
            ? () => prefetchArtist(info.id)
            : info.itemType === "album"
              ? () => prefetchAlbum(info.id)
              : undefined
        }
        onContextMenu={mix ? undefined : context(item.type, item)}
        contextActions={mix && item.type === "playlist" ? [
          { label: "Open mix", run: () => { if (currentProvider()) { selectMix(item); navigate("/mix") } } },
          ...(provider?.getMixTracks && item.providerKey ? [{ label: "Play mix", run: () => playMix(item) }] : []),
        ] : undefined}
        dragPayload={makeDragPayload(item)}
        scrollItem
      />
    )
  }
  const row = (title: string, items: MusicItem[], mix = false) => (
    <section aria-label={title} className="min-w-0">
      <h2 className="mb-3 text-xl font-semibold">{title}</h2>
      <div
        className="flex gap-3 overflow-x-auto pb-3"
        onFocusCapture={(event) => {
          // Browser focus scrolling may expose only a link's focus point.
          // Reveal its complete card without moving the page vertically.
          const row = event.currentTarget
          let card = event.target as HTMLElement
          while (card.parentElement && card.parentElement !== row)
            card = card.parentElement
          if (card.parentElement !== row) return
          const viewport = row.getBoundingClientRect()
          const bounds = card.getBoundingClientRect()
          if (bounds.right > viewport.right)
            row.scrollLeft += bounds.right - viewport.right
          else if (bounds.left < viewport.left)
            row.scrollLeft -= viewport.left - bounds.left
        }}
      >
        {items.map((item) => card(item, mix))}
      </div>
    </section>
  )
  const hasSuggestions =
    selected.recent.length ||
    selected.mixes.length ||
    selected.recommendations.length
  return (
    <div className="mt-6 min-w-0 space-y-6">
      {playError && (
        <p role="alert" className="text-sm text-red-400">
          Could not play this mix. Please try again.
        </p>
      )}
      {selected.recent.length > 0 && (
        <section aria-label="Jump back in">
          <h2 className="mb-3 text-xl font-semibold">Jump back in</h2>
          <MediaGrid gap={3}>
            {selected.recent.map((item) => (
              <RecentTile
                key={`${item.type}:${item.id}`}
                item={item}
                onPlay={makeOnPlay(item, { ...playback, provider })}
              />
            ))}
          </MediaGrid>
        </section>
      )}
      {selected.mixes.length > 0 && row("Made for you", selected.mixes, true)}
      {selected.recommendations.map((h) => (
        <div key={h.identifier}>{row(h.title, h.items)}</div>
      ))}
      {!hasSuggestions && (
        <p className="text-sm text-[var(--text-secondary)]">
          {provider
            ? "Your listening suggestions will appear here when your library has them."
            : "Connect your music library in Settings to see listening suggestions."}
        </p>
      )}
      <div className="flex flex-wrap gap-4 text-sm">
        <Link href="/library" className="text-accent hover:underline">
          Browse Library
        </Link>
        {(!provider || provider.capabilities.stations) && (
          <Link href="/stations" className="text-accent hover:underline">
            Explore Stations
          </Link>
        )}
        {!provider && (
          <Link href="/settings" className="text-accent hover:underline">
            Connect a library
          </Link>
        )}
      </div>
    </div>
  )
}
