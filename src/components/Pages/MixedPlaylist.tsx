import { Button } from "../shared/Button"
import { Checkbox } from "../shared/Checkbox"
import { useEffect, useMemo, useRef, useState } from "react"
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
import { ArtworkImage } from "../shared/ArtworkImage"
import { AmbientHeroBackdrop } from "../shared/MediaBackdrop"
import type { MusicTrack } from "../../types/music"
import { playlistSourceLabel, playlistServices } from "../../mixedPlaylists/model"
import { projection } from "../../mixedPlaylists/reconcile"
import { CreatePlaylist } from "./CreatePlaylist"
import { useDragStore } from "../../stores/dragStore"

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
  return <div className="media-detail-page playlist-detail-page pb-12" data-playlist-drop-target={playlist.local ? id : undefined}>
    {editing && <CreatePlaylist playlist={playlist} onClose={() => setEditing(false)} />}
    <AmbientHeroBackdrop heroRef={heroRef} />
    <div ref={heroRef} className="media-detail-hero hero-overlay relative flex flex-wrap items-end gap-5 text-white">
      <ArtworkImage src={playlist.artwork ?? tracks[0]?.thumbUrl ?? null} alt="" className="h-44 w-44 rounded-lg object-cover" />
      <div className="relative min-w-0 flex-1"><h1 className="media-detail-title wrap-break-word">{playlist.title}</h1>
        <p className="my-3 text-sm text-(--artwork-hero-secondary,#ddd)">{playlistSourceLabel(playlist)} · {tracks.length.toLocaleString()} songs</p>
        {playlist.description && <p className="mb-4 max-w-prose whitespace-pre-wrap text-sm text-(--artwork-hero-secondary,#ddd)">{playlist.description}</p>}
        <div className="flex flex-wrap gap-3"><Button size="md" variant="primary" type="button" className="media-primary" disabled={!tracks.length} onClick={() => play()}>Play</Button>
          <Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy} onClick={() => run(state.sync(id, true))}>{busy ? "Syncing…" : "Match and sync"}</Button>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={playlist.automatic} onChange={event => run(state.automatic(id, event.target.checked))} />Automatic sync</label>
          {playlist.local && <Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy || !!playlist.write || !!playlist.detailsWrite || !!playlist.artworkWrite || !!playlist.listenbrainz?.detailsWrite} onClick={() => setEditing(true)}>Edit details</Button>}
        </div>
      </div>
    </div>
    <div className="mx-8 mb-6 space-y-3 text-sm text-(--text-secondary)" aria-live="polite">
      <p>{error ?? playlist.message ?? "Songs are retained locally while their counterparts are matched."}</p>
      {playlist.merge && <p>{services.map(service => `${service === "plex" ? "Plex" : "YTM"}: ${playlist.baseline[service]?.items.length ?? 0} synced / ${projection(playlist, service).length} representable`).join(" · ")} · {playlist.items.length} saved in Hibiki</p>}
      {(playlist.detailsWrite || playlist.artworkWrite) && <div className="space-y-2"><p>Review the current details on the service before retrying. For a changed Plex image, this accepts its current image.</p><Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy} onClick={() => run(state.sync(id, true))}>Review and retry details</Button></div>}
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
      {playlist.write && <div className="flex flex-wrap items-center gap-2">
        {playlist.write.kind === "create" && !playlist.write.destinationId && <input aria-label="Created playlist ID" placeholder="ID of the playlist created on the service" value={recovery} onChange={event => setRecovery(event.target.value)} className="rounded border border-(--border) bg-app-surface px-3 py-2" />}
        <Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy} onClick={() => run(state.recover(id, recovery || undefined))}>Review and retry pending write</Button>
        {playlist.write.kind === "create" && !playlist.write.destinationId && <div className="w-full space-y-2"><label className="flex items-center gap-2"><Checkbox checked={noCreation} onChange={event => setNoCreation(event.target.checked)} />I checked {playlist.write.service === "plex" ? "Plex" : "YouTube Music"}; no playlist was created.</label><Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy || !noCreation} onClick={() => { setNoCreation(false); run(state.recover(id, undefined, true)) }}>Retry creation after review</Button></div>}
      </div>}
      {pending.length > 0 && <details><summary className="cursor-pointer">{pending.length} songs awaiting a counterpart</summary>
        <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto">{pending.map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3">
          <span>{row.songs[row.original]!.track.title} · {row.match.status}{row.match.message ? ` — ${row.match.message}` : ""}</span>
          <Button size="md" variant="secondary" type="button" className="media-secondary" disabled={busy} onClick={() => run(state.edit(id, { kind: "delete", index: playlist.items.findIndex(item => item.id === row.id) }))}>Remove from playlist</Button>
        </li>)}</ul>
      </details>}
    </div>
    {!tracks.length ? <div className={`mx-8 py-16 text-center ${hovered ? "bg-accent-tint" : ""}`}><h2 className="text-xl font-semibold">Make it your playlist</h2><p className="mt-3 text-sm text-(--text-secondary)">Drag songs here or onto this playlist in the sidebar. They’re saved in Hibiki before syncing.</p></div> : <div className="px-8"><TrackTable tracks={sorted} visibleCols={visible} toggleCol={toggle} sortCol={sortCol} sortDir={sortDir} onSort={handleSort}
      columns={ALL_COLUMNS} filterQuery={query} onFilterChange={setQuery} searchPlaceholder="Search playlist" currentTrackId={activeTrack}
      onPlay={play} onAddToQueue={items => usePlayerStore.getState().addToQueue(items)} onPlayRadio={(trackId, type) => { void usePlayerStore.getState().playRadio(trackId, type) }}
      onRemoveTrack={async track => { await state.edit(id, { kind: "delete", index: playlist.items.findIndex(row => row.id === track.playlistItemId) }) }}
      onReorder={!busy && !query && sortCol === "default" ? (from, to) => run(state.edit(id, { kind: "move", from, to })) : undefined} />
    </div>}
  </div>
}
