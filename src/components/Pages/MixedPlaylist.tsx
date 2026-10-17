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

export function MixedPlaylist({ id }: { id: string }) {
  const heroRef = useRef<HTMLDivElement>(null)
  const state = useMixedPlaylistStore(), provider = useProviderStore(s => s.provider)
  const youtube = useYoutubeMusicDiscoveryStore()
  const playlist = state.playlists.find(item => item.id === id)
  const [error, setError] = useState<string | null>(null), [recovery, setRecovery] = useState("")
  const [query, setQuery] = useState("")
  const { visible, toggle } = usePlaylistColumns("plex-playlist-columns")
  const { sortCol, sortDir, handleSort } = useTableSort<TrackSortColumn>({ resetKey: id })
  const activeTrack = usePlayerStore(s => s.currentTrack?.id)
  useEffect(() => { void state.load().catch(() => {}) }, [id])
  const tracks = useMemo(() => playlist ? mixedPlaylistTracks(playlist) : [], [playlist])
  const sorted = useMemo(() => sortTracks(filterTracks(tracks, query), sortCol, sortDir), [tracks, query, sortCol, sortDir])
  if (!playlist) return <PageRecovery kind={state.loaded ? "empty" : "error"} title={state.loaded ? "Playlist unavailable" : "Loading playlist…"} description={state.error ?? "This playlist is stored on this device."} />
  if (playlist.owners.plex !== provider?.cacheScope || playlist.owners.ytmusic !== youtube.accountId || !youtube.connected)
    return <PageRecovery kind="empty" title="Reconnect this playlist’s accounts" description="Connect the original Plex library and YouTube Music account to view this mixed playlist." />
  const run = (operation: Promise<unknown>) => { setError(null); void operation.catch(failure => setError(String(failure instanceof Error ? failure.message : failure))) }
  const play = (track?: MusicTrack, all = sorted, index = 0) => {
    if (all.length) void playMixedPlaylist(playlist, track ? index : 0, all)
  }
  const busy = state.running[id], pending = playlist.items.filter(row => row.match.status !== "matched")
  return <div className="media-detail-page playlist-detail-page pb-12">
    <AmbientHeroBackdrop heroRef={heroRef} />
    <div ref={heroRef} className="media-detail-hero hero-overlay relative flex flex-wrap items-end gap-5">
      <ArtworkImage src={tracks[0]?.thumbUrl ?? null} alt="" className="h-44 w-44 rounded-lg object-cover" />
      <div className="relative min-w-0 flex-1"><h1 className="media-detail-title wrap-break-word">{playlist.title}</h1>
        <p className="my-3 text-sm text-(--text-secondary)">Plex + YouTube Music · {tracks.length.toLocaleString()} songs</p>
        <div className="flex flex-wrap gap-3"><button type="button" className="media-primary" disabled={!tracks.length} onClick={() => play()}>Play</button>
          <button type="button" className="media-secondary" disabled={busy} onClick={() => run(state.sync(id, true))}>{busy ? "Syncing…" : "Match and sync"}</button>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={playlist.automatic} onChange={event => run(state.automatic(id, event.target.checked))} />Automatic sync</label>
        </div>
      </div>
    </div>
    <div className="mx-8 mb-6 space-y-3 text-sm text-(--text-secondary)" aria-live="polite">
      <p>{error ?? playlist.message ?? "Songs are retained locally while their counterparts are matched."}</p>
      {playlist.status === "conflict" && <div className="flex flex-wrap items-center gap-2"><span>Keep the current order from:</span>
        {(["plex", "ytmusic", "hibiki"] as const).map(side => <button key={side} type="button" className="media-secondary" disabled={busy} onClick={() => run(state.chooseOrder(id, side))}>{side === "plex" ? "Plex" : side === "ytmusic" ? "YTM" : "Hibiki"}</button>)}
      </div>}
      {playlist.write && <div className="flex flex-wrap items-center gap-2">
        {playlist.write.kind === "create" && !playlist.write.destinationId && <input aria-label="Created playlist ID" placeholder="ID of the playlist created on the service" value={recovery} onChange={event => setRecovery(event.target.value)} className="rounded border border-(--border) bg-app-surface px-3 py-2" />}
        <button type="button" className="media-secondary" disabled={busy} onClick={() => run(state.recover(id, recovery || undefined))}>Review and retry pending write</button>
      </div>}
      {pending.length > 0 && <details><summary className="cursor-pointer">{pending.length} songs awaiting a counterpart</summary>
        <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto">{pending.map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3">
          <span>{row.songs[row.original]!.track.title} · {row.match.status}{row.match.message ? ` — ${row.match.message}` : ""}</span>
          <button type="button" className="media-secondary" disabled={busy} onClick={() => run(state.edit(id, { kind: "delete", index: playlist.items.findIndex(item => item.id === row.id) }))}>Remove from playlist</button>
        </li>)}</ul>
      </details>}
    </div>
    <div className="px-8"><TrackTable tracks={sorted} visibleCols={visible} toggleCol={toggle} sortCol={sortCol} sortDir={sortDir} onSort={handleSort}
      columns={ALL_COLUMNS} filterQuery={query} onFilterChange={setQuery} searchPlaceholder="Search playlist" currentTrackId={activeTrack}
      onPlay={play} onAddToQueue={items => usePlayerStore.getState().addToQueue(items)} onPlayRadio={(trackId, type) => { void usePlayerStore.getState().playRadio(trackId, type) }}
      onRemoveTrack={async track => { await state.edit(id, { kind: "delete", index: playlist.items.findIndex(row => row.id === track.playlistItemId) }) }}
      onReorder={!busy && !query && sortCol === "default" ? (from, to) => run(state.edit(id, { kind: "move", from, to })) : undefined} />
    </div>
  </div>
}
