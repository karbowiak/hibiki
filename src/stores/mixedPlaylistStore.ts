import { create } from "zustand"
import { mixedPlaylistRepository } from "../mixedPlaylists/repository"
import { captureMusicOwner, resolveCounterpart } from "../mixedPlaylists/counterparts"
import { mixedAdapters } from "../mixedPlaylists/adapters"
import { matchPlaylistBatch } from "../mixedPlaylists/matching"
import { adoptRemote } from "../mixedPlaylists/reconcile"
import { hydratePlaylist, sameSequence, snapshotIds, playlistServices, type MixedPlaylist, type Service } from "../mixedPlaylists/model"
import { appendDraftSongs, newDraft, reviewUnappliedCreation, validateDraftMetadata, type DraftMetadata } from "../mixedPlaylists/drafts"
import { syncMixedPlaylist } from "../mixedPlaylists/sync"
import { syncDraftDetails } from "../mixedPlaylists/details"
import { syncDraftListenBrainz } from "../mixedPlaylists/listenbrainz"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import type { MusicTrack } from "../types/music"
import { verifyPlaylistIdentity } from "../mixedPlaylists/identity"
import { matchingUpdateAffectsRecording } from "../matching/changes"
import type { MatchingUpdate } from "../matching/updates"
import { queryIndexedMusic } from "../matching/service"
import { trackMatchingSource } from "../matching/sources"

interface State {
  playlists: MixedPlaylist[]
  loaded: boolean
  error: string | null
  running: Record<string, boolean>
  load(): Promise<void>
  createDraft(metadata: DraftMetadata, id?: string): Promise<MixedPlaylist>
  metadata(id: string, metadata: DraftMetadata): Promise<void>
  externalSync(id: string, options?: { recoveryId?: string; prefer?: "hibiki" | "listenbrainz"; reviewNoCreation?: boolean }): Promise<void>
  convert(alias: string): Promise<MixedPlaylist>
  append(alias: string, tracks: MusicTrack[], admission: string): Promise<void>
  sync(id: string, retry?: boolean): Promise<void>
  edit(id: string, operation: { kind: "move"; from: number; to: number } | { kind: "delete"; index: number }): Promise<void>
  chooseOrder(id: string, side: Service | "hibiki"): Promise<void>
  recover(id: string, destinationId?: string, reviewedNotApplied?: boolean): Promise<void>
  automatic(id: string, enabled: boolean): Promise<void>
  retryIndexedMatches(update?: MatchingUpdate): Promise<void>
}
const matchingCursors = new Map<string, number>()
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
  const service = alias.startsWith("ytmusic:") ? "ytmusic" : "plex"
  const existing = (await mixedPlaylistRepository.load()).find(item => (item.id === alias || item.aliases.includes(alias)) &&
    (item.local || Object.entries(item.owners).every(([side, owner]) => capture.owners[side as Service] === owner)))
  if (existing) return existing
  if (!capture.owners.plex || !capture.owners.ytmusic) throw Error("Connect Plex and YouTube Music to use mixed playlists.")
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
  createDraft: (metadata, id = `mixed:${crypto.randomUUID()}`) => serial(id, async () => {
    const existing = (await mixedPlaylistRepository.load()).find(item => item.id === id)
    if (existing) {
      const value = validateDraftMetadata(metadata)
      if (JSON.stringify([existing.title, existing.description, existing.artwork, existing.external]) !== JSON.stringify([value.title, value.description, value.artwork, value.external])) {
        if (existing.write || existing.detailsWrite || existing.artworkWrite) throw Error("This playlist was saved. Review its pending sync before changing details.")
        return save({ ...existing, ...value })
      }
      publish(existing); return existing
    }
    return save(newDraft(metadata, id))
  }),
  metadata: (id, metadata) => serial(id, async () => {
    const value = validateDraftMetadata(metadata), playlist = await latest(id)
    if (!playlist.local) throw Error("This playlist’s metadata is managed by its source service.")
    if (playlist.write || playlist.detailsWrite || playlist.artworkWrite || playlist.listenbrainz?.detailsWrite) throw Error("Review the pending provider write before editing playlist details.")
    await save({ ...playlist, ...value })
    void get().sync(id).catch(() => {})
  }),
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
      await save(appendDraftSongs(playlist, tracks, capture.owners, admission))
    })
    void get().sync(playlist.id).catch(() => {})
  }),
  sync: (id, retry = false) => serial(id, async () => {
    const capture = captureMusicOwner()
    let playlist = await latest(id)
    if (!playlist.items.length && !Object.keys(playlist.providers).length) return
    // Only an explicit retry can bind songs added without a connected owner.
    if (playlist.local && retry) {
      const owners = { ...playlist.owners }
      for (const row of playlist.items) if (!owners[row.original] && capture.owners[row.original]) owners[row.original] = capture.owners[row.original]
      playlist = await save({ ...playlist, owners })
    }
    if (playlist.items.some(row => !playlist.owners[row.original]))
      throw Error("Connect the original music account, then choose Match and sync to connect these local songs.")
    const current = () => capture.current() && Object.entries(playlist.owners).every(([side, owner]) => capture.owners[side as Service] === owner)
    if (!current()) throw Error("Reconnect this playlist's original accounts to sync.")
    set(state => ({ running: { ...state.running, [id]: true } }))
    try {
      const checked = await verifyPlaylistIdentity(playlist, { provider: capture.provider, current })
      if (checked !== playlist) playlist = await save(checked)
      const verify = async (value: MixedPlaylist, snapshots: import("../mixedPlaylists/model").RemotePlaylist[]) => {
        const checked = await verifyPlaylistIdentity(value, { provider: capture.provider, current, snapshots })
        return checked === value ? value : save(checked)
      }
      if (!retry && !playlist.write && playlist.items.some(row => Object.values(row.songs).some(song => song?.stale))) return
      const adapters = mixedAdapters(capture)
      playlist = await syncDraftDetails(playlist, { adapters, current, save, provider: capture.provider, review: retry, settleOnly: true })
      if (playlist.status === "conflict" || playlist.write) {
        playlist = await syncMixedPlaylist(playlist, { adapters: mixedAdapters(capture), current, save, maxWrites: 0, verify })
        if (playlist.status === "conflict" || playlist.write) return
      }
      for (const target of playlistServices(playlist)) {
        // Retry prior misses after catalog changes, without starving new rows.
        if (retry || playlist.items.some(row => !row.songs[target] && row.match.checkedAt && Date.now() - row.match.checkedAt > 3600000))
          playlist = await save({ ...playlist, items: playlist.items.map(row => (row.songs[target] && !row.songs[target]?.stale) || (!retry && (!row.match.checkedAt || Date.now() - row.match.checkedAt <= 3600000)) ? row : { ...row, match: { status: "pending" } }) })
        const batch = await matchPlaylistBatch(playlist, target, { current, save, limit: 20,
          resolve: track => resolveCounterpart(track, target, retry) })
        playlist = batch.playlist
      }
      if (!current()) return
      if (playlist.items.some(row => Object.values(row.songs).some(song => song?.stale))) return
      playlist = await syncMixedPlaylist(playlist, { adapters, current, save, maxWrites: 10, verify })
      if (playlist.items.some(row => Object.values(row.songs).some(song => song?.stale))) return
      if (useListenBrainzStore.getState().isAuthenticated)
        playlist = await syncDraftListenBrainz(playlist, { current, save, provider: capture.provider, manual: retry, owners: capture.owners })
      await syncDraftDetails(playlist, { adapters, current, save, provider: capture.provider, review: retry })
    } catch (failure) {
      if (current()) {
        const retained = await latest(id)
        await save({ ...retained, status: retained.status === "conflict" ? "conflict" : "error", message: String(failure instanceof Error ? failure.message : failure) })
      }
      throw failure
    } finally { set(state => ({ running: { ...state.running, [id]: false } })) }
  }),
  externalSync: (id, options = {}) => serial(id, async () => {
    const capture = captureMusicOwner()
    let playlist = await latest(id)
    const current = () => capture.current() && Object.entries(playlist.owners).every(([side, owner]) => capture.owners[side as Service] === owner)
    if (!current()) throw Error("Reconnect this playlist’s original music accounts.")
    set(state => ({ running: { ...state.running, [id]: true } }))
    try {
      const adapters = mixedAdapters(capture)
      const snapshots = playlist.providers.plex && adapters.plex ? [await adapters.plex.read(playlist.providers.plex.id)] : []
      const checked = await verifyPlaylistIdentity(playlist, { provider: capture.provider, current, snapshots })
      if (checked !== playlist) playlist = await save(checked)
      if (playlist.items.some(row => Object.values(row.songs).some(song => song?.stale))) throw Error("Match the changed recording before syncing this playlist.")
      playlist = await syncDraftListenBrainz(playlist, { current, save, provider: capture.provider, owners: capture.owners, manual: true, ...options })
      if (current()) void get().sync(id).catch(() => {})
    } catch (failure) {
      if (current()) await save({ ...await latest(id), status: "error", message: failure instanceof Error ? failure.message : String(failure) })
      throw failure
    } finally { set(state => ({ running: { ...state.running, [id]: false } })) }
  }),
  edit: (id, operation) => serial(id, async () => {
    const playlist = await latest(id), capture = captureMusicOwner()
    if (!playlist.local && !Object.entries(playlist.owners).every(([side, owner]) => capture.owners[side as Service] === owner)) throw Error("Reconnect this playlist's original accounts.")
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
  recover: (id, destinationId, reviewedNotApplied) => serial(id, async () => {
    const capture = captureMusicOwner(), playlist = await latest(id), receipt = playlist.write
    if (!receipt) return
    const adapter = mixedAdapters(capture)[receipt.service]
    if (!adapter || adapter.owner !== playlist.owners[receipt.service]) throw Error("Reconnect the playlist's original account.")
    if (reviewedNotApplied) {
      if (!capture.current()) throw Error("Playlist account changed.")
      await save(reviewUnappliedCreation(playlist))
      void get().sync(id).catch(() => {})
      return
    }
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
  retryIndexedMatches: async update => {
    const capture = captureMusicOwner(), provider = capture.provider
    if (!get().loaded || !provider?.matchingResolve || provider.isOffline || update && update.provider !== provider) return
    for (const retained of get().playlists) {
      if (!capture.current()) return
      if (retained.owners.plex !== capture.owners.plex || retained.owners.ytmusic !== capture.owners.ytmusic) continue
      await serial(retained.id, async () => {
        let playlist = await latest(retained.id)
        const current = () => capture.current()
        if (update) {
          const ids = update.reset ? undefined : new Set(update.changes.filter(change => change.kind === "track").map(change => String(change.id)))
          if (ids) for (const row of playlist.items) {
            const track = row.songs.plex?.track
            if (track && update.changes.some(change => change.kind === "album" && String(change.id) === track.albumId || change.kind === "artist" && String(change.id) === track.artistId)) ids.add(track.id)
          }
          if (!ids || ids.size) {
            const checked = await verifyPlaylistIdentity(playlist, { provider, current, ids })
            if (checked !== playlist) playlist = await save(checked)
          }
        }
        const candidates = playlist.items.filter(row => (!row.songs.plex || row.songs.plex.stale) &&
          row.songs[row.original] && (!update || matchingUpdateAffectsRecording(update, row.songs[row.original]!.track)))
        if (!candidates.length) return
        const cursor = matchingCursors.get(playlist.id) ?? 0
        const batch = Array.from({ length: Math.min(20, candidates.length) }, (_, offset) => candidates[(cursor + offset) % candidates.length])
        matchingCursors.set(playlist.id, (cursor + batch.length) % candidates.length)
        if (matchingCursors.size > 256) matchingCursors.delete(matchingCursors.keys().next().value!)
        const results = await Promise.all(batch.map(row => queryIndexedMusic(trackMatchingSource(row.songs[row.original]!.track)).catch(() => null)))
        if (!current()) return
        const eligible = new Set(batch.filter((_, index) => results[index]?.status === "matched").map(row => row.songs[row.original]!.track))
        if (!eligible.size) return
        await matchPlaylistBatch(playlist, "plex", { current, save, limit: 20, retry: true, eligible: track => eligible.has(track),
          resolve: track => resolveCounterpart(track, "plex") })
      })
    }
  },
}))
