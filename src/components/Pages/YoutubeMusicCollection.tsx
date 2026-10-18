import { Button } from "../shared/Button"
import { MusicEntityLink } from "../shared/MusicEntityLink"
import { ArtistCredits } from "../shared/ArtistCredits"
import { PlaylistHero } from "../shared/PlaylistHero"
import { MediaBackdrop } from "../shared/MediaBackdrop"
import { buildExternalImageUrl } from "../../lib/imageUrl"
import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { browseYoutubeMusic, observeYoutubeMusicPages, useYoutubeMusicDiscovery, useYoutubeMusicDiscoveryStore, youtubeMusicCollectionSource, youtubeMusicItemTrack, type YoutubeMusicBrowsePage } from "../../backends/ytmusic/discovery"
import { useYoutubeMusicLibraryStore } from "../../backends/ytmusic/library"
import { useDiscoveryFeed } from "../../hooks/useDiscoveryFeed"
import { usePlayerStore } from "../../stores/playerStore"
import { useUIStore } from "../../stores/uiStore"
import { useProviderStore } from "../../stores/providerStore"
import { loadAlbumPage } from "../../stores/metadataCache"
import { artistNameSimilarity, ARTIST_NAME_THRESHOLD } from "../../lib/artistMatching"
import { releaseNameKey, sameRecording } from "../../lib/musicMatching"
import { TrackTable } from "../shared/TrackTable"
import { ALL_COLUMNS, usePlaylistColumns } from "../../hooks/useColumnPicker"
import { useTableSort } from "../../hooks/useTableSort"
import { filterTracks, sortTracks, type TrackSortColumn } from "../../lib/trackOrder"
import { formatTotalMs } from "../../lib/formatters"
import type { PagedTrackSource } from "../../lib/pagedPlayback"
import { PlaylistAction } from "../shared/PlaylistAction"
import { DiscoveryCard } from "../shared/DiscoveryCard"
import { ScrollRow } from "../ScrollRow"
import { DiscoveryMore } from "../shared/DiscoveryMore"
import { PageLoading } from "../shared/PageLoading"
import { PageRecovery } from "../shared/PageRecovery"
import { YoutubeMusicLogo } from "../shared/MusicSource"
import { useMixedPlaylistLink } from "../MixedPlaylistControl"
import { useMixedPlaylistStore } from "../../stores/mixedPlaylistStore"
import { useContextMenuStore } from "../../stores/contextMenuStore"
import { PlaylistInformationDialog } from "../PlaylistInformationDialog"
import { CreatePlaylist } from "./CreatePlaylist"
import { resolveIndexedMusic } from "../../matching/service"
import { albumMatchingSource } from "../../matching/sources"
import { matchingKey, subscribeMatchingUpdates } from "../../matching/updates"

export function YoutubeMusicCollection({ browseId }: { browseId: string }) {
  const [, navigate] = useLocation()
  const provider = useProviderStore(state => state.provider)
  const heroRef = useRef<HTMLDivElement>(null)
  const youtube = useYoutubeMusicDiscovery()
  const linker = useMixedPlaylistLink(`ytmusic:${browseId}`)
  const mixed = useMixedPlaylistStore()
  const linked = mixed.playlists.find(item => item.aliases.includes(`ytmusic:${browseId}`) && item.owners.ytmusic === youtube.accountId)
  const [information, setInformation] = useState(false), [editing, setEditing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const library = useYoutubeMusicLibraryStore()
  const refresh = useUIStore(state => state.pageRefreshKey)
  const openedAtRefresh = useRef(refresh)
  const identity = useMemo(() => ({}), [browseId, youtube.revision, refresh])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  useEffect(() => () => {
    const menu = useContextMenuStore.getState()
    if (menu.type === "actions" && menu.data && "owner" in menu.data && menu.data.owner === identity) menu.close()
  }, [identity])
  const [detail, setDetail] = useState<{ identity: object; page: YoutubeMusicBrowsePage } | null>(null)
  const metadata = detail?.identity === identity ? detail.page : null
  const player = usePlayerStore(useShallow(state => ({ playPagedTracks: state.playPagedTracks,
    addToQueue: state.addToQueue, currentTrack: state.currentTrack })))
  const destination = { browseId }
  const card = [...youtube.hubs.flatMap(hub => hub.items), ...Object.values(library).flatMap(collection => collection.items)]
    .find(item => item.id === browseId)
  const slice = (cursor: string | null, page: YoutubeMusicBrowsePage) => {
    if (cursor === null && currentIdentity.current === identity && useYoutubeMusicDiscoveryStore.getState().revision === youtube.revision)
      setDetail({ identity, page })
    return { items: page.items.filter(item => item.kind === "song"), next: page.continuation ?? undefined, title: page.title }
  }
  const feed = useDiscoveryFeed(youtube.revision, youtube.connected ? `${browseId}:${refresh}` : null, [], item => item.id,
    youtube.connected ? async cursor => {
      const page = await browseYoutubeMusic(destination, typeof cursor === "string" ? cursor : null,
        cursor === null && refresh !== openedAtRefresh.current)
      return slice(typeof cursor === "string" ? cursor : null, page)
    } : null, receive => observeYoutubeMusicPages(destination, (cursor, page) => receive(cursor, slice(cursor, page))), true)
  const tracks = useMemo(() => feed.items.map(item => {
    const track = youtubeMusicItemTrack(item)
    return browseId.startsWith("MPRE") ? { ...track, albumId: track.albumId ?? `ytmusic:${browseId}`, albumName: track.albumName || metadata?.title || card?.title || "" } : track
  }), [feed.items, browseId, metadata?.title, card?.title])
  const albumTitle = card?.title || metadata?.title
  const albumArtist = card?.artist || metadata?.items.find(item => item.kind === "song" && item.artist)?.artist
  const albumYear = card?.year
  const session = provider?.playbackSession, scope = provider?.cacheScope
  const [matchingRevision, setMatchingRevision] = useState(0)
  useEffect(() => subscribeMatchingUpdates(update => {
    if (update.provider === provider && (update.reset || update.coverageChanged || update.changes.some(change => change.kind === "album" && change.titleKey === matchingKey(albumTitle ?? ""))))
      setMatchingRevision(value => value + 1)
  }), [provider, albumTitle])
  useEffect(() => {
    if (!browseId.startsWith("MPRE") || !provider || provider.isOffline || !metadata || !albumTitle || !albumArtist) return
    let active = true
    const owns = () => active && currentIdentity.current === identity && useProviderStore.getState().provider === provider &&
      provider.playbackSession === session && provider.cacheScope === scope
    void (async () => {
      if (provider.matchingResolve) {
        const source = albumMatchingSource({ id: `ytmusic:${browseId}`, title: albumTitle, artistName: albumArtist, year: albumYear ?? 0 },
          metadata.items.filter(item => item.kind === "song").map(youtubeMusicItemTrack).map(track => ({ kind: "track", title: track.title, duration: track.duration })))
        const proof = await resolveIndexedMusic(source).catch(() => null)
        if (!owns()) return
        if (proof) {
          if (proof.status === "matched" && proof.selected) navigate(`/album/${proof.selected}`, { replace: true })
          return
        }
      }
      const results = await provider.search(albumTitle, "album")
      if (!owns()) return
      const candidates = [...new Map(results.flatMap(item => item.type === "album" && releaseNameKey(item.title) === releaseNameKey(albumTitle) &&
        artistNameSimilarity(item.artistName, albumArtist) >= ARTIST_NAME_THRESHOLD && (!albumYear || !item.year || item.year === albumYear)
        ? [[item.id, item] as const] : [])).values()]
      if (!candidates.length || candidates.length > 4) return
      const catalogs = await Promise.all(candidates.map(item => loadAlbumPage(item.id)))
      if (!owns()) return
      const remote = metadata.items.filter(item => item.kind === "song").map(youtubeMusicItemTrack)
      const ranked = catalogs.map(entry => ({ entry, overlap: entry.tracks.filter(local => remote.some(track => sameRecording(local, track))).length }))
        .sort((a, b) => b.overlap - a.overlap)
      const best = ranked[0]
      if (best && (best.overlap > 0 || !best.entry.tracks.length) && (ranked.length === 1 || best.overlap > ranked[1].overlap))
        navigate(`/album/${encodeURIComponent(best.entry.album.id)}`, { replace: true })
    })().catch(() => { /* The YTM album remains usable without a Plex match. */ })
    return () => { active = false }
  }, [browseId, provider, session, scope, identity, metadata, albumTitle, albumArtist, albumYear, navigate, matchingRevision])
  const [filterQuery, setFilterQuery] = useState("")
  const [query, setQuery] = useState("")
  useEffect(() => { const timer = setTimeout(() => setQuery(filterQuery), 150); return () => clearTimeout(timer) }, [filterQuery])
  useEffect(() => { setFilterQuery(""); setQuery("") }, [browseId])
  const { visible: visibleCols, toggle: toggleCol } = usePlaylistColumns("plex-playlist-columns")
  const { sortCol, sortDir, handleSort } = useTableSort<TrackSortColumn>({ resetKey: browseId })
  const sorted = useMemo(() => sortTracks(filterTracks(tracks, query), sortCol, sortDir), [tracks, query, sortCol, sortDir])
  const title = card?.title || feed.title || "YouTube Music"
  const artwork = card?.thumbnail || metadata?.thumbnail
  const cover = artwork ? buildExternalImageUrl(artwork) : tracks[0]?.thumbUrl ?? null
  const artists = [...new Set(tracks.map(track => track.artistName).filter(Boolean))].slice(0, 8).join(" · ")
  const href = `/ytmusic/${encodeURIComponent(browseId)}`
  const source: PagedTrackSource = query || sortCol !== "default" ? {
    key: `ytmusic:${browseId}:${query}:${sortCol}:${sortDir}`, total: sorted.length, entries: sorted,
    loadPage: async (offset, limit) => ({ items: sorted.slice(offset, offset + limit), total: sorted.length, offset }),
  } : youtubeMusicCollectionSource(destination, { items: feed.items,
    continuation: feed.more && typeof feed.nextCursor === "string" ? feed.nextCursor : null })
  const play = (shuffle = false, index = 0) => {
    if (youtube.connected) void player.playPagedTracks(source, title, href, shuffle, index)
  }
  const loading = !tracks.length && (feed.loading || (!feed.error && feed.more))
  const totalMs = tracks.reduce((sum, track) => sum + track.duration, 0)
  const count = feed.more ? Math.max(card?.trackCount ?? 0, tracks.length) : tracks.length
  const description = card?.description || metadata?.description || artists
  const sync = () => {
    if (!linked) return
    setSyncError(null)
    void mixed.sync(linked.id, true).catch(failure => setSyncError(failure instanceof Error ? failure.message : String(failure)))
  }
  const radio = () => {
    if (!sorted.length) return
    const seed = sorted[Math.floor(Math.random() * sorted.length)]
    void usePlayerStore.getState().playRadio(seed.id, "track", title, "ytmusic", seed)
  }
  if (!youtube.connected) return <PageRecovery kind="empty" title="Connect YouTube Music" description="Sign in with the YTM button to browse this collection." />
  if (!card && !metadata && loading) return <PageLoading message="Loading playlist…" variant="playlist" />
  return <div className="media-detail-page playlist-detail-page pb-12">
    {editing && linked && <CreatePlaylist key={linked.id} playlist={linked} onClose={() => setEditing(false)} />}
    {information && <PlaylistInformationDialog playlist={{ id: `ytmusic:${browseId}`, title, smart: !browseId.startsWith("VLPL"), trackCount: count, duration: totalMs, thumbUrl: cover, summary: description, addedAt: null, providerKey: "ytmusic" }}
      sourceLabel="YouTube Music" downloadsSupported={false} onClose={() => setInformation(false)} onReviewSync={() => { setInformation(false); if (linked) setEditing(true); else void linker.link() }}
      syncContent={<div className="space-y-3 text-sm"><p>{linked ? "Linked to Hibiki. Review service links and unmatched songs in Edit playlist." : "This playlist has no configured Hibiki sync."}</p>
        {browseId.startsWith("VLPL") && <Button disabled={linker.pending || !linker.connected} onClick={() => { setInformation(false); if (linked) setEditing(true); else void linker.link() }}>{linked ? "Edit playlist and review links" : "Link Plex + YTM"}</Button>}
      </div>} />}
    <MediaBackdrop src={cover} heroRef={heroRef} />
    <PlaylistHero heroRef={heroRef} artwork={cover} title={title}
      byline={<p className="mt-2 flex items-center gap-2 text-sm text-(--text-secondary)"><YoutubeMusicLogo size={16} />YouTube Music</p>}
      description={<>
            {browseId.startsWith("MPRE") && albumArtist && <p className="mt-2 text-sm text-(--text-secondary)">
              {tracks[0] ? <ArtistCredits item={tracks[0]} className="hover:underline" /> : <MusicEntityLink entity={{ kind: "artist", name: albumArtist, id: card?.artistId ? `ytmusic:${card.artistId}` : null }} className="hover:underline">{albumArtist}</MusicEntityLink>}
            </p>}
            {description && description !== albumArtist && <p className="mt-2 line-clamp-2 max-w-xl text-sm text-(--text-secondary)">{description}</p>}
      </>}>
            <PlaylistAction action="play" onClick={() => play()} disabled={!sorted.length} />
            <PlaylistAction action="shuffle" onClick={() => play(true)} disabled={!sorted.length} />
            <PlaylistAction action="radio" onClick={radio} disabled={!sorted.length} />
            <PlaylistAction action="sync" onClick={sync} disabled={!linked || mixed.running[linked.id]} title={linked ? "Match and sync this playlist" : "Configure sync from More first"}>{linked && mixed.running[linked.id] ? "Syncing…" : "Sync"}</PlaylistAction>
            <PlaylistAction action="more" title="More actions" aria-haspopup="dialog" onClick={event => {
              const rect = event.currentTarget.getBoundingClientRect()
              useContextMenuStore.getState().showActions(rect.right, rect.bottom + 4, { title, owner: identity, actions: [
                ...(browseId.startsWith("VLPL") ? [{ label: linked ? "Review song links" : "Link Plex + YTM", disabled: linker.pending || !linker.connected,
                  run: () => { if (linked) setEditing(true); else void linker.link() } }] : []),
                ...(linked ? [{ label: "Edit playlist", run: () => setEditing(true) }] : []),
                { label: "Refresh playlist", run: () => useUIStore.getState().incrementPageRefreshKey() },
              ] })
            }} />
            <PlaylistAction action="info" aria-label="Playlist information" aria-haspopup="dialog" onClick={() => setInformation(true)} />
            {(linker.error || syncError) && <p role="alert" className="basis-full text-sm text-(--text-secondary)">{linker.error || syncError}</p>}
    </PlaylistHero>
    <dl className="media-ledger playlist-overview" aria-label="Playlist overview">
      <div><dt>Songs</dt><dd>{count.toLocaleString()}{feed.more && !card?.trackCount ? "+" : ""}</dd></div>
      {totalMs > 0 && <div><dt>Runtime{feed.more ? " so far" : ""}</dt><dd>{formatTotalMs(totalMs)}</dd></div>}
    </dl>
    <TrackTable tracks={sorted} visibleCols={visibleCols} toggleCol={toggleCol} sortCol={sortCol} sortDir={sortDir} onSort={handleSort}
      onPlay={(_track, _all, index) => play(false, index ?? 0)} onAddToQueue={player.addToQueue} onPlayRadio={() => {}} showRadio={false}
      columns={ALL_COLUMNS} searchPlaceholder="Search in playlist…" filterQuery={filterQuery} onFilterChange={setFilterQuery}
      defaultResetTitle="Restore playlist order" isLoading={loading} isFetchingMore={feed.loading && !!tracks.length}
      currentTrackId={player.currentTrack?.id} emptyMessage={query ? feed.more ? "No matches in loaded songs. Load more songs or clear the filter." : "No songs match this filter." : "This collection has no audio tracks."} />
    <div className="px-8"><DiscoveryMore more={feed.more} loading={feed.loading} error={feed.error} load={() => void feed.loadMore()} /></div>
    {metadata?.hubs.map(hub => <div className="mt-8 px-8" key={hub.id}><ScrollRow title={hub.title} restoreKey={`${browseId}:${hub.id}`}>
      {hub.items.map(item => <DiscoveryCard key={item.id} entry={{ source: "ytmusic", item }} scrollItem />)}
    </ScrollRow></div>)}
  </div>
}
