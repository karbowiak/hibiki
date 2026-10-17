import { create } from "zustand"
import { mixedPlaylistRepository } from "../mixedPlaylists/repository"
import { captureMusicOwner, resolveCounterpart } from "../mixedPlaylists/counterparts"
import { mixedAdapters } from "../mixedPlaylists/adapters"
import { matchPlaylistBatch } from "../mixedPlaylists/matching"
import { adoptRemote } from "../mixedPlaylists/reconcile"
import { hydratePlaylist, newOccurrence, sameSequence, snapshotIds, type MixedPlaylist, type Service } from "../mixedPlaylists/model"
import { syncMixedPlaylist } from "../mixedPlaylists/sync"
import type { MusicTrack } from "../types/music"

interface State {
  playlists: MixedPlaylist[]
  loaded: boolean
  error: string | null
  running: Record<string, boolean>
  load(): Promise<void>
  convert(alias: string): Promise<MixedPlaylist>
  append(alias: string, tracks: MusicTrack[], admission: string): Promise<void>
  sync(id: string, retry?: boolean): Promise<void>
  edit(id: string, operation: { kind: "move"; from: number; to: number } | { kind: "delete"; index: number }): Promise<void>
  chooseOrder(id: string, side: Service | "hibiki"): Promise<void>
  recover(id: string, destinationId?: string): Promise<void>
  automatic(id: string, enabled: boolean): Promise<void>
}
const lanes = new Map<string, Promise<unknown>>()
function serial<T>(id: string, run: () => Promise<T>): Promise<T> {
  const work = (lanes.get(id) ?? Promise.resolve()).catch(() => {}).then(run)
  lanes.set(id, work)
  void work.finally(() => { if (lanes.get(id) === work) lanes.delete(id) }).catch(() => {})
  return work
}
let load: Promise<void> | undefined
function publish(playlist: MixedPlaylist) {
  useMixedPlaylistStore.setState(state => ({ playlists: [...state.playlists.filter(item => item.id !== playlist.id), playlist] }))
}
async function save(playlist: MixedPlaylist) {
  const retained = await mixedPlaylistRepository.save(playlist)
  publish(retained)
  return retained
}
async function latest(id: string) {
  const playlist = (await mixedPlaylistRepository.load()).find(item => item.id === id)
  if (!playlist) throw Error("Playlist is no longer available.")
  return playlist
}
async function register(alias: string) {
  const capture = captureMusicOwner(), adapters = mixedAdapters(capture)
  if (!capture.owners.plex || !capture.owners.ytmusic) throw Error("Connect Plex and YouTube Music to use mixed playlists.")
  const service = alias.startsWith("ytmusic:") ? "ytmusic" : "plex"
  const existing = (await mixedPlaylistRepository.load()).find(item => (item.id === alias || item.aliases.includes(alias)) &&
    Object.entries(item.owners).every(([side, owner]) => capture.owners[side as Service] === owner))
  if (existing) return existing
  const snapshot = await adapters[service]!.read(alias.replace(/^ytmusic:/, ""))
  if (!capture.current()) throw Error("Music accounts changed.")
  if (snapshot.readOnly) throw Error("Choose an owned, regular playlist. Smart playlists and generated mixes are read-only.")
  const initial = hydratePlaylist(snapshot)
  return save({ ...initial, owners: capture.owners, automatic: true, baselineOrder: initial.items.map(row => row.id), baselineTitle: initial.title })
}

export const useMixedPlaylistStore = create<State>((set, get) => ({
  playlists: [], loaded: false, running: {}, error: null,
  load: () => {
    if (load) return load
    const work = mixedPlaylistRepository.load().then(playlists => set({ playlists, loaded: true, error: null }))
      .catch(failure => { set({ error: String(failure), loaded: false }); throw failure })
    load = work
    void work.finally(() => { if (load === work) load = undefined }).catch(() => {})
    return work
  },
  convert: alias => serial(`alias:${alias}`, async () => {
    const playlist = await register(alias)
    void get().sync(playlist.id).catch(() => {})
    return playlist
  }),
  append: (alias, tracks, admission) => serial(`alias:${alias}`, async () => {
    if (!tracks.length || tracks.length > 1000) throw Error("Choose between 1 and 1,000 songs to add at once.")
    const capture = captureMusicOwner()
    let playlist = await register(alias)
    await serial(playlist.id, async () => {
      playlist = await latest(playlist.id)
      if (!capture.current()) throw Error("Music accounts changed before the songs could be retained.")
      if (playlist.admittedDrops.includes(admission)) return
      await save({ ...playlist, items: [...playlist.items, ...tracks.map(track => newOccurrence(track))],
        admittedDrops: [...playlist.admittedDrops, admission], message: "Songs retained in Hibiki. Matching and provider sync will continue in the background." })
    })
    void get().sync(playlist.id).catch(() => {})
  }),
  sync: (id, retry = false) => serial(id, async () => {
    const capture = captureMusicOwner()
    let playlist = await latest(id)
    const current = () => capture.current() && Object.entries(playlist.owners).every(([side, owner]) => capture.owners[side as Service] === owner)
    if (!current()) throw Error("Reconnect this playlist's original accounts to sync.")
    set(state => ({ running: { ...state.running, [id]: true } }))
    try {
      if (playlist.status === "conflict" || playlist.write) {
        playlist = await syncMixedPlaylist(playlist, { adapters: mixedAdapters(capture), current, save, maxWrites: 0 })
        if (playlist.status === "conflict" || playlist.write) return
      }
      for (const target of ["plex", "ytmusic"] as const) {
        // Retry prior misses after catalog changes, without starving new rows.
        if (retry || playlist.items.some(row => !row.songs[target] && row.match.checkedAt && Date.now() - row.match.checkedAt > 3600000))
          playlist = await save({ ...playlist, items: playlist.items.map(row => row.songs[target] || (!retry && (!row.match.checkedAt || Date.now() - row.match.checkedAt <= 3600000)) ? row : { ...row, match: { status: "pending" } }) })
        const batch = await matchPlaylistBatch(playlist, target, { current, save, limit: 20,
          resolve: track => resolveCounterpart(track, target, retry) })
        playlist = batch.playlist
      }
      if (!current()) return
      await syncMixedPlaylist(playlist, { adapters: mixedAdapters(capture), current, save, maxWrites: 10 })
    } catch (failure) {
      if (current()) {
        const retained = await latest(id)
        await save({ ...retained, status: retained.status === "conflict" ? "conflict" : "error", message: String(failure instanceof Error ? failure.message : failure) })
      }
      throw failure
    } finally { set(state => ({ running: { ...state.running, [id]: false } })) }
  }),
  edit: (id, operation) => serial(id, async () => {
    const playlist = await latest(id), capture = captureMusicOwner()
    if (!Object.entries(playlist.owners).every(([side, owner]) => capture.owners[side as Service] === owner)) throw Error("Reconnect this playlist's original accounts.")
    if (playlist.write || playlist.status === "conflict") throw Error("Resolve the pending playlist sync before editing its order.")
    const items = [...playlist.items]
    const index = operation.kind === "delete" ? operation.index : operation.from
    if (!Number.isInteger(index) || index < 0 || index >= items.length) throw Error("Choose a valid playlist occurrence.")
    if (operation.kind === "delete") items.splice(index, 1)
    else {
      if (!Number.isInteger(operation.to) || operation.to < 0 || operation.to >= items.length) throw Error("Choose a valid playlist position.")
      const [row] = items.splice(operation.from, 1); items.splice(operation.to, 0, row)
    }
    await save({ ...playlist, items })
    void get().sync(id).catch(() => {})
  }),
  chooseOrder: (id, side) => serial(id, async () => {
    const capture = captureMusicOwner(), adapters = mixedAdapters(capture)
    let playlist = await latest(id)
    if (playlist.write) throw Error("Review the pending write before choosing an order.")
    const snapshots = []
    for (const service of ["plex", "ytmusic"] as const) if (playlist.providers[service]) {
      if (adapters[service]?.owner !== playlist.owners[service]) throw Error("Playlist account changed.")
      snapshots.push(await adapters[service]!.read(playlist.providers[service]!.id))
    }
    if (!capture.current()) return
    if (side !== "hibiki") playlist = adoptRemote(playlist, snapshots.find(snapshot => snapshot.service === side)!)
    await save({ ...playlist, baseline: { ...playlist.baseline, ...Object.fromEntries(snapshots.map(snapshot => [snapshot.service, snapshot])) },
      baselineOrder: playlist.items.map(row => row.id), baselineTitle: playlist.title, status: "ready", message: "Order selected. Sync can continue." })
    void get().sync(id).catch(() => {})
  }),
  recover: (id, destinationId) => serial(id, async () => {
    const capture = captureMusicOwner(), playlist = await latest(id), receipt = playlist.write
    if (!receipt) return
    const adapter = mixedAdapters(capture)[receipt.service]
    if (!adapter || adapter.owner !== playlist.owners[receipt.service]) throw Error("Reconnect the playlist's original account.")
    const target = destinationId ?? receipt.destinationId ?? playlist.providers[receipt.service]?.id
    if (!target) throw Error("Enter the ID of the playlist created on the service.")
    const actual = await adapter.read(target)
    if (!capture.current()) return
    const complete = sameSequence(snapshotIds(actual), receipt.afterIds)
    const unchanged = receipt.before && sameSequence(snapshotIds(actual), snapshotIds(receipt.before))
    if (!complete && !unchanged) throw Error("The current playlist matches neither the before nor after snapshot. Resolve its contents on the provider before retrying.")
    if (actual.readOnly) throw Error("The recovery playlist must be writable.")
    await save({ ...playlist, write: undefined, providers: { ...playlist.providers, [receipt.service]: { id: actual.id, readOnly: actual.readOnly } },
      baseline: { ...playlist.baseline, [receipt.service]: actual }, status: "ready", message: "Write reviewed. Sync can continue." })
    void get().sync(id).catch(() => {})
  }),
  automatic: (id, enabled) => serial(id, async () => { await save({ ...await latest(id), automatic: enabled }) }),
}))
