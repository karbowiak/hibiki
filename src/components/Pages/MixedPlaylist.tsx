import { Button } from "../shared/Button"
import { Checkbox } from "../shared/Checkbox"
import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useSearch } from "wouter"
import { mixedPlaylistTracks, playMixedPlaylist } from "../../mixedPlaylists/playback"
import { useMixedPlaylistStore } from "../../stores/mixedPlaylistStore"
import { useProviderStore } from "../../stores/providerStore"
import { useYoutubeMusicDiscoveryStore } from "../../backends/ytmusic/discovery"
import { usePlayerStore } from "../../stores/playerStore"
import { TrackTable } from "../shared/TrackTable"
import { ALL_COLUMNS, usePlaylistColumns } from "../../hooks/useColumnPicker"
import { filterTracks, sortTracks, type TrackSortColumn } from "../../lib/trackOrder"
import { useTableSort } from "../../hooks/useTableSort"
import { PageRecovery } from "../shared/PageRecovery"
import { PlaylistHero } from "../shared/PlaylistHero"
import { AmbientHeroBackdrop } from "../shared/MediaBackdrop"
import type { MusicTrack } from "../../types/music"
import { playlistSourceLabel, playlistServices } from "../../mixedPlaylists/model"
import { projection } from "../../mixedPlaylists/reconcile"
import { counterpartPending } from "../../mixedPlaylists/matching"
import { CreatePlaylist } from "./CreatePlaylist"
import { useDragStore } from "../../stores/dragStore"
import { formatTotalMs } from "../../lib/formatters"
import { PlaylistAction } from "../shared/PlaylistAction"
import { useContextMenuStore } from "../../stores/contextMenuStore"
import { PlaylistInformationDialog } from "../PlaylistInformationDialog"
import { draftPlaylistSummary } from "../../mixedPlaylists/create"

export function MixedPlaylist({ id }: { id: string }) {
  const heroRef = useRef<HTMLDivElement>(null)
  const state = useMixedPlaylistStore(), provider = useProviderStore(s => s.provider)
  const youtube = useYoutubeMusicDiscoveryStore()
  const playlist = state.playlists.find(item => item.id === id)
  const [error, setError] = useState<string | null>(null), [recovery, setRecovery] = useState("")
  const [query, setQuery] = useState("")
  const [externalRecovery, setExternalRecovery] = useState("")
  const [noCreation, setNoCreation] = useState(false), [noExternalCreation, setNoExternalCreation] = useState(false)
  useEffect(() => { setNoCreation(false); setNoExternalCreation(false) }, [id, playlist?.write?.id, playlist?.listenbrainz?.link?.id])
  const [editing, setEditing] = useState(false)
  const [information, setInformation] = useState(false)
  const search = useSearch()
  const [location, navigate] = useLocation()
  useEffect(() => {
    if (new URLSearchParams(search).get("info") === "sync") {
      setInformation(true)
      navigate(location, { replace: true })
    }
  }, [id, search, location, navigate])
  const [matchLimit, setMatchLimit] = useState(50)
  const menuOwner = useMemo(() => ({}), [id])
  useEffect(() => () => {
    const menu = useContextMenuStore.getState()
    if (menu.type === "actions" && menu.data && "owner" in menu.data && menu.data.owner === menuOwner) menu.close()
  }, [menuOwner])
  const hovered = useDragStore(state => state.isDragging && state.hoveredPlaylistId === id)
  const { visible, toggle } = usePlaylistColumns("plex-playlist-columns")
  const { sortCol, sortDir, handleSort } = useTableSort<TrackSortColumn>({ resetKey: id })
  const activeTrack = usePlayerStore(s => s.currentTrack?.id)
  useEffect(() => { void state.load().catch(() => {}) }, [id])
  const tracks = useMemo(() => playlist ? mixedPlaylistTracks(playlist) : [], [playlist])
  const sorted = useMemo(() => sortTracks(filterTracks(tracks, query), sortCol, sortDir), [tracks, query, sortCol, sortDir])
  if (!playlist) return <PageRecovery kind={state.loaded ? "empty" : "error"} title={state.loaded ? "Playlist unavailable" : "Loading playlist…"} description={state.error ?? "This playlist is stored on this device."} />
  if (!playlist.local && (playlist.owners.plex !== provider?.cacheScope || playlist.owners.ytmusic !== youtube.accountId || !youtube.connected))
    return <PageRecovery kind="empty" title="Reconnect this playlist’s accounts" description="Connect the original Plex library and YouTube Music account to view this mixed playlist." />
  const run = (operation: Promise<unknown>) => { setError(null); void operation.catch(failure => setError(String(failure instanceof Error ? failure.message : failure))) }
  const play = (track?: MusicTrack, all = sorted, index = 0) => {
    if (all.length) void playMixedPlaylist(playlist, track ? index : 0, all)
  }
  const services = playlistServices(playlist)
  const busy = state.running[id], pending = playlist.items.filter(row => services.some(service => !row.songs[service] || row.songs[service]?.stale))
  const totalMs = tracks.reduce((sum, track) => sum + track.duration, 0)
  const syncError = error ?? (playlist.status === "error" || playlist.status === "conflict" ? playlist.message : null)
  const needsSyncDetails = syncError || playlist.external?.listenbrainz.enabled || playlist.status === "conflict" ||
    !busy && (playlist.write || playlist.detailsWrite || playlist.artworkWrite)
  const missingByService = services.map(service => ({ service, count: playlist.items.filter(row => !row.songs[service] || row.songs[service]?.stale).length })).filter(item => item.count)
  const missingLabel = missingByService.map(({ service, count }) => `${count} unmatched ${service === "plex" ? "Plex" : "YTM"}`).join(", ")
  const syncDetails = needsSyncDetails && <div className="space-y-3 text-sm text-(--text-secondary)">
      {syncError && <p role="alert">{syncError}</p>}
      {!busy && (playlist.detailsWrite || playlist.artworkWrite) && <div className="space-y-2"><p>Review the current details on the service before retrying. For a changed Plex image, this accepts its current image.</p><Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy} onClick={() => run(state.sync(id, true))}>Review and retry details</Button></div>}
      {playlist.external?.listenbrainz.enabled && <details className="space-y-3"><summary className="cursor-pointer">ListenBrainz sync</summary>
        <p>{playlist.listenbrainz?.message ?? "Only verified recording IDs are synced. Unmatched songs stay in Hibiki."}</p>
        <div className="flex flex-wrap gap-2"><Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy} onClick={() => run(state.externalSync(id))}>Sync ListenBrainz</Button>
          {playlist.listenbrainz?.link?.state === "conflict" && <>{(["hibiki", "listenbrainz"] as const).map(prefer => <Button size="md" variant="secondary" key={prefer} type="button" className="media-secondary" disabled={busy} onClick={() => run(state.externalSync(id, { prefer }))}>Keep {prefer === "hibiki" ? "Hibiki" : "ListenBrainz"} order</Button>)}</>}
        </div>
        {!playlist.listenbrainz?.link && playlist.listenbrainz?.creationPending && <div className="space-y-3"><div className="flex flex-wrap gap-2"><input aria-label="Created ListenBrainz playlist ID" placeholder="Earlier ListenBrainz playlist ID" value={externalRecovery} onChange={event => setExternalRecovery(event.target.value)} className="app-input min-w-0 flex-1" /><Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy || !externalRecovery.trim()} onClick={() => run(state.externalSync(id, { recoveryId: externalRecovery.trim() }))}>Recover earlier creation</Button></div>
          <label className="flex items-center gap-2"><Checkbox checked={noExternalCreation} onChange={event => setNoExternalCreation(event.target.checked)} />I checked ListenBrainz; no playlist was created.</label><Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy || !noExternalCreation} onClick={() => { setNoExternalCreation(false); run(state.externalSync(id, { reviewNoCreation: true })) }}>Retry ListenBrainz creation after review</Button>
        </div>}
        {playlist.listenbrainz?.link?.job?.step && <Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy} onClick={() => run(state.externalSync(id))}>Review and retry pending ListenBrainz write</Button>}
      </details>}
      {playlist.status === "conflict" && <div className="flex flex-wrap items-center gap-2"><span>Keep the current order from:</span>
        {(["plex", "ytmusic", "hibiki"] as const).map(side => <Button size="md" variant="secondary" key={side} type="button" className="media-secondary" disabled={busy} onClick={() => run(state.chooseOrder(id, side))}>{side === "plex" ? "Plex" : side === "ytmusic" ? "YTM" : "Hibiki"}</Button>)}
      </div>}
      {playlist.write && !busy && <div className="flex flex-wrap items-center gap-2">
        {playlist.write.kind === "create" && !playlist.write.destinationId && <input aria-label="Created playlist ID" placeholder="ID of the playlist created on the service" value={recovery} onChange={event => setRecovery(event.target.value)} className="rounded border border-(--border) bg-app-surface px-3 py-2" />}
        <Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy} onClick={() => run(state.recover(id, recovery || undefined))}>Review and retry pending write</Button>
        {playlist.write.kind === "create" && !playlist.write.destinationId && <div className="w-full space-y-2"><label className="flex items-center gap-2"><Checkbox checked={noCreation} onChange={event => setNoCreation(event.target.checked)} />I checked {playlist.write.service === "plex" ? "Plex" : "YouTube Music"}; no playlist was created.</label><Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy || !noCreation} onClick={() => { setNoCreation(false); run(state.recover(id, undefined, true)) }}>Retry creation after review</Button></div>}
      </div>}
    </div>
  const remaining = playlist.items.filter(row => services.some(service => counterpartPending(row, service))).length
  const progressLabel = remaining ? `${remaining} left to check` : missingLabel
  const scoredMatches = playlist.items.filter(row => row.match.status === "matched" && typeof row.match.confidence === "number")
    .sort((a, b) => a.match.confidence! - b.match.confidence!)
  const radio = () => {
    if (!sorted.length) return
    const seed = sorted[Math.floor(Math.random() * sorted.length)]
    const plexAvailable = !!provider?.createRadioQueue && !provider.isOffline
    void usePlayerStore.getState().playRadio(seed.id, "track", playlist.title,
      youtube.connected ? plexAvailable ? "mixed" : "ytmusic" : "plex", seed)
  }
  return <div className="media-detail-page playlist-detail-page pb-12" data-playlist-drop-target={playlist.local ? id : undefined}>
    {editing && <CreatePlaylist key={id} playlist={playlist} onClose={() => setEditing(false)} />}
    {information && <PlaylistInformationDialog playlist={{ ...draftPlaylistSummary(playlist), duration: totalMs, thumbUrl: playlist.artwork ?? tracks[0]?.thumbUrl ?? null }}
      sourceLabel={playlistSourceLabel(playlist)} downloadsSupported={false} onClose={() => setInformation(false)} onReviewSync={() => { setInformation(false); setEditing(true) }}
      syncContent={<div className="space-y-4 text-sm">
        <p>{missingLabel || "All songs have service counterparts."}{remaining > 0 && ` ${playlist.items.length - remaining} of ${playlist.items.length} songs checked; matching continues in the background.`}</p>
        {syncDetails}
        {scoredMatches.length > 0 && <details><summary className="cursor-pointer">Match confidence · {scoredMatches.length} songs</summary>
          <p className="mt-2 text-xs text-(--text-secondary)">Scores compare title, artists, duration and album. Lower scores are more uncertain.</p>
          <ul className="mt-3 max-h-72 divide-y divide-(--border) overflow-y-auto">{scoredMatches.slice(0, matchLimit).map(row => {
            const original = row.songs[row.original]!.track
            const counterpart = row.songs[row.original === "plex" ? "ytmusic" : "plex"]?.track
            return <li key={row.id} className="py-3 pr-2"><div className="flex items-start justify-between gap-3"><span>{original.title} · {original.artistName}</span><span className="shrink-0 tabular-nums">{Math.round(row.match.confidence! * 100)}%</span></div>
              {counterpart && <p className="mt-1 text-xs text-(--text-secondary)">{row.original === "plex" ? "YTM" : "Plex"}: {counterpart.title} · {counterpart.artistName}</p>}</li>
          })}</ul>
          {matchLimit < scoredMatches.length && <Button className="mt-3" onClick={() => setMatchLimit(value => value + 50)}>Show more matches</Button>}
        </details>}
        <Button onClick={() => { setInformation(false); setEditing(true) }}>Edit playlist and review matches</Button>
      </div>} />}
    <AmbientHeroBackdrop heroRef={heroRef} />
    <PlaylistHero heroRef={heroRef} artwork={playlist.artwork ?? tracks[0]?.thumbUrl ?? null} title={playlist.title}
      byline={<p className="mt-2 text-sm text-(--text-secondary)">{playlistSourceLabel(playlist)}</p>}
      description={playlist.description && <p className="mt-2 line-clamp-2 max-w-xl whitespace-pre-wrap text-sm text-(--text-secondary)">{playlist.description}</p>}>
          <PlaylistAction action="play" disabled={!sorted.length} onClick={() => play()} />
          <PlaylistAction action="shuffle" disabled={!sorted.length} onClick={() => void playMixedPlaylist(playlist, 0, sorted, true)} />
          <PlaylistAction action="radio" disabled={!sorted.length || (!youtube.connected && (!provider?.createRadioQueue || provider.isOffline))} onClick={radio} />
          <PlaylistAction action="sync" title="Match and sync this playlist" aria-label="Match and sync playlist" disabled={busy} onClick={() => run(state.sync(id, true))}>{busy ? "Syncing…" : "Sync"}</PlaylistAction>
          <PlaylistAction action="more" title="More actions" aria-haspopup="dialog" onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect()
            useContextMenuStore.getState().showActions(rect.right, rect.bottom + 4, { title: playlist.title, owner: menuOwner, actions: [
              { label: "Edit playlist", run: () => setEditing(true) },
              { label: "Review song links", run: () => setEditing(true) },
              { label: "Retry unmatched songs", disabled: busy || !pending.length, run: () => run(state.sync(id, true)) },
            ] })
          }} />
          <PlaylistAction action="info" aria-label="Playlist information" aria-haspopup="dialog" onClick={() => setInformation(true)} />
    </PlaylistHero>
    <dl className="media-ledger playlist-overview" aria-label="Playlist overview">
      <div><dt>Songs</dt><dd>{tracks.length.toLocaleString()}</dd></div>
      {totalMs > 0 && <div><dt>Runtime</dt><dd>{formatTotalMs(totalMs)}</dd></div>}
      {services.length > 0 && <div className="playlist-sync-summary" data-mixed-sync-status aria-live="polite" aria-busy={!!busy}>
        <dt className="flex items-center gap-3"><span>{busy ? "Syncing" : "Sync"}</span>
          {!!progressLabel && <span className="playlist-sync-pending" title={remaining ? `${remaining} songs awaiting matching. Matches and sync details are in Info.` : `${missingLabel}. Review song links in Edit playlist.`}>{progressLabel}</span>}
        </dt>
        <dd>
          <div className="flex gap-x-3 tabular-nums" data-mixed-sync-counts>
            {services.map(service => <span key={service} className="whitespace-nowrap" title="Songs synced / songs available on this service">{service === "plex" ? "Plex" : "YTM"}: {playlist.baseline[service]?.items.length ?? 0} / {projection(playlist, service).length}</span>)}
          </div>
        </dd>
      </div>}
    </dl>
    {!tracks.length ? <div className={`py-16 text-center ${hovered ? "bg-accent-tint" : ""}`}><h2 className="text-xl font-semibold">Make it your playlist</h2><p className="mt-3 text-sm text-(--text-secondary)">Drag songs here or onto this playlist in the sidebar. They’re saved in Hibiki before syncing.</p></div> : <TrackTable tracks={sorted} visibleCols={visible} toggleCol={toggle} sortCol={sortCol} sortDir={sortDir} onSort={handleSort}
      columns={ALL_COLUMNS} filterQuery={query} onFilterChange={setQuery} searchPlaceholder="Search in playlist…" defaultResetTitle="Restore playlist order" currentTrackId={activeTrack}
      onPlay={play} onAddToQueue={items => usePlayerStore.getState().addToQueue(items)} onPlayRadio={(trackId, type) => { void usePlayerStore.getState().playRadio(trackId, type) }}
      onRemoveTrack={async track => { await state.edit(id, { kind: "delete", index: playlist.items.findIndex(row => row.id === track.playlistItemId) }) }}
      onReorder={!busy && !query && sortCol === "default" ? (from, to) => run(state.edit(id, { kind: "move", from, to })) : undefined} />
    }
  </div>
}
