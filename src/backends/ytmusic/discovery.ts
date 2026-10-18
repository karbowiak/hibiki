import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { create } from "zustand"
import { useEffect } from "react"
import { youtubeMusicApi, type YoutubeMusicStatus } from "./api"
import { clearYoutubeMusicHistory } from "./history"
import { youtubeMusicTrack } from "./tracks"
import type { PagedTrackSource } from "../../lib/pagedPlayback"
import { discoveryPages } from "../../lib/discoveryPages"
import { buildExternalImageUrl } from "../../lib/imageUrl"
import { useYoutubeMusicLikesStore } from "./likes"
import type { MusicItem, MusicArtistCredit } from "../../types/music"
import { normalizeArtistCredits } from "../../lib/artistCredits"
import { withTimeout } from "../../lib/withTimeout"

export interface YoutubeMusicItem {
  unavailable?: boolean
  id: string
  kind: "song" | "album" | "playlist" | "artist"
  title: string
  artist: string
  artistCredits?: MusicArtistCredit[]
  description?: string
  thumbnail: string | null
  duration: string | null
  album: string | null
  year: number | null
  releaseDate?: string | null
  playedAt?: number
  trackCount?: number | null
  albumId?: string | null
  artistId?: string | null
  trackNumber?: number | null
  explicit?: boolean | null
  viewCount?: number | null
  liked?: boolean | null
  videoType?: string | null
}
export interface YoutubeMusicDestination { browseId: string; params?: string | null }
export interface YoutubeMusicHub {
  id: string
  title: string
  category: "releases" | "mixes" | "recent" | "music" | "songs" | "albums" | "singles" | "live" | "features" | "playlists" | "similar"
  items: YoutubeMusicItem[]
  destination: YoutubeMusicDestination | null
  continuation: string | null
}
export interface YoutubeMusicBrowsePage {
  title: string
  items: YoutubeMusicItem[]
  hubs: YoutubeMusicHub[]
  continuation: string | null
  thumbnail?: string | null
  description?: string | null
  artist?: YoutubeMusicArtist | null
  lyrics?: { lines: import("../../providers/types").LyricLineData[]; attribution: string | null; missing: boolean } | null
}
export interface YoutubeMusicArtist {
  id: string
  channelId?: string | null
  name: string
  thumbnail: string | null
  background: string | null
  description: string | null
  monthlyListeners: string | null
  subscribers: string | null
  songs: YoutubeMusicDestination | null
  shuffle: YoutubeMusicDestination | null
}
export interface YoutubeMusicCatalogUpdate extends YoutubeMusicDestination {
  continuation: string | null
  includePerformances: boolean
  clientRevision: number | null
  page: YoutubeMusicBrowsePage
}
const catalogListeners = new Set<(update: YoutubeMusicCatalogUpdate) => void>()
const catalogRequests = new Map<string, { force: boolean; promise: Promise<YoutubeMusicBrowsePage> }>()
const catalogUpdates = new Map<string, { sequence: number; page: YoutubeMusicBrowsePage }>()
let catalogSequence = 0, catalogEvents: Promise<void> | null = null
const catalogKey = (destination: YoutubeMusicDestination, continuation: string | null, performances: boolean) =>
  JSON.stringify([destination.browseId, destination.params ?? null, continuation, performances])

function startCatalogEvents() {
  if (!catalogEvents) catalogEvents = listen<YoutubeMusicCatalogUpdate>("ytmusic://catalog", event => {
    const update = event.payload
    const state = useYoutubeMusicDiscoveryStore.getState()
    if (!state.connected || update.clientRevision !== state.revision) return
    useYoutubeMusicLikesStore.getState().observe([...update.page.items, ...update.page.hubs.flatMap(hub => hub.items)])
    const key = catalogKey(update, update.continuation, update.includePerformances)
    catalogUpdates.delete(key)
    catalogUpdates.set(key, { sequence: ++catalogSequence, page: update.page })
    if (catalogUpdates.size > 128) catalogUpdates.delete(catalogUpdates.keys().next().value!)
    catalogListeners.forEach(receive => receive(update))
  }).then(() => {}).catch(() => { catalogEvents = null })
  return catalogEvents
}

/** Updates carry parsed catalog data only; connection changes retire old events. */
export function subscribeYoutubeMusicCatalog(receive: (update: YoutubeMusicCatalogUpdate) => void) {
  catalogListeners.add(receive)
  return () => { catalogListeners.delete(receive) }
}

export function observeYoutubeMusicPages(destination: YoutubeMusicDestination,
  receive: (cursor: string | null, page: YoutubeMusicBrowsePage) => void, includePerformances = false) {
  return subscribeYoutubeMusicCatalog(update => {
    if (update.browseId === destination.browseId && (update.params ?? null) === (destination.params ?? null) &&
      update.includePerformances === includePerformances) receive(update.continuation, update.page)
  })
}

export function browseYoutubeMusic(destination: YoutubeMusicDestination, continuation?: string | null, force = false, includePerformances = false, background = false): Promise<YoutubeMusicBrowsePage> {
  const revision = useYoutubeMusicDiscoveryStore.getState().revision
  const pageKey = catalogKey(destination, continuation ?? null, includePerformances)
  const key = `${revision}:${pageKey}:${background ? "background" : "foreground"}`
  const existing = catalogRequests.get(key)
  if (existing && (!force || existing.force)) return existing.promise
  const before = catalogSequence
  const likeMutation = useYoutubeMusicLikesStore.getState().mutation
  const promise = withTimeout((async () => {
    await startCatalogEvents()
    const owns = () => useYoutubeMusicDiscoveryStore.getState().connected && useYoutubeMusicDiscoveryStore.getState().revision === revision
    if (!owns()) throw Error("YouTube Music connection changed.")
    const page = await invoke<YoutubeMusicBrowsePage>("ytmusic_browse", { browseId: destination.browseId,
      params: destination.params ?? null, continuation: continuation ?? null, force, includePerformances, clientRevision: revision, background })
    if (!owns()) throw Error("YouTube Music connection changed.")
    // A very fast background response can beat the cached IPC response.
    const updated = catalogUpdates.get(pageKey)
    const result = updated && updated.sequence > before ? updated.page : page
    useYoutubeMusicLikesStore.getState().observe([...result.items, ...result.hubs.flatMap(hub => hub.items)], likeMutation, force)
    return result
  })(), 20_000, "YouTube Music did not respond. Please try again.")
  catalogRequests.set(key, { force, promise })
  void promise.then(() => { if (catalogRequests.get(key)?.promise === promise) catalogRequests.delete(key) },
    () => { if (catalogRequests.get(key)?.promise === promise) catalogRequests.delete(key) })
  return promise
}
export const youtubeMusicItemCredits = (item: YoutubeMusicItem) => normalizeArtistCredits(item.artist, item.artistId ? `ytmusic:${item.artistId}` : null,
  item.artistCredits?.map(credit => ({ ...credit, id: credit.id ? `ytmusic:${credit.id}` : null })))
export const youtubeMusicItemTrack = (item: YoutubeMusicItem) => ({ ...youtubeMusicTrack({
  unavailable: item.unavailable,
  videoId: item.id, title: item.title, artist: item.artist, album: item.album,
  duration: item.duration, thumbnail: item.thumbnail,
}), year: item.year ?? 0, trackNumber: item.trackNumber ?? 0, explicit: item.explicit ?? undefined,
  viewCount: item.viewCount ?? undefined, albumId: item.albumId ? `ytmusic:${item.albumId}` : null,
  artistId: item.artistId ? `ytmusic:${item.artistId}` : null,
  artistCredits: youtubeMusicItemCredits(item),
  _providerData: { youtubeMusic: item } })
export const youtubeMusicItemHref = (item: YoutubeMusicItem) => `/ytmusic/${encodeURIComponent(item.id)}`

export function youtubeMusicItemMusic(item: YoutubeMusicItem): MusicItem {
  const common = { id: `ytmusic:${item.id}`, title: item.title, thumbUrl: buildExternalImageUrl(item.thumbnail),
    userRating: null, addedAt: null, guid: null, providerKey: "ytmusic", _providerData: { youtubeMusic: item } }
  if (item.kind === "song") return { ...youtubeMusicItemTrack(item), _providerData: common._providerData, type: "track" }
  if (item.kind === "artist") return { ...common, type: "artist", artUrl: null, summary: item.description || null }
  if (item.kind === "album") return { ...common, type: "album", artistId: item.artistId ? `ytmusic:${item.artistId}` : null,
    artistName: item.artist, artistThumbUrl: null, year: item.year ?? 0, releaseDate: item.releaseDate,
    artistCredits: youtubeMusicItemCredits(item),
    trackCount: item.trackCount ?? 0, studio: null, summary: item.description || null,
    genres: [], styles: [], moods: [], labels: [], format: null }
  return { ...common, type: "playlist", smart: false, trackCount: item.trackCount ?? 0, duration: null, summary: item.description || null }
}

export function originalYoutubeMusicItem(item: MusicItem): YoutubeMusicItem | null {
  return item.providerKey === "ytmusic" ? (item._providerData as { youtubeMusic?: YoutubeMusicItem } | null)?.youtubeMusic ?? null : null
}

interface DiscoveryState {
  connected: boolean
  accountId?: string | null
  revision: number
  hubs: YoutubeMusicHub[]
  loading: boolean
  error: boolean
}
export const useYoutubeMusicDiscoveryStore = create<DiscoveryState>(() => ({ connected: false, revision: 0, hubs: [], loading: false, error: false }))
useYoutubeMusicDiscoveryStore.subscribe(state => {
  useYoutubeMusicLikesStore.getState().connect(state.connected ? state.revision : null)
})
let started = false, pending: Promise<void> | null = null
let home = discoveryPages<YoutubeMusicHub>(hub => hub.id)
const extraHubs = new Map<string, YoutubeMusicHub>()
let homeContinuation: Promise<void> | null = null

function publishHubs() {
  const hubs = new Map((home.read()?.items ?? []).map(hub => [hub.id, hub]))
  extraHubs.forEach(hub => hubs.set(hub.id, hub))
  useYoutubeMusicDiscoveryStore.setState({ hubs: [...hubs.values()] })
}

function saveHomePage(cursor: string | null, page: YoutubeMusicBrowsePage) {
  home.set(cursor, { items: page.hubs, next: page.continuation ?? undefined })
  publishHubs()
}

function saveExtraHub(browseId: string, page: YoutubeMusicBrowsePage) {
  const releases = browseId === "FEmusic_new_releases_albums"
  const hub: YoutubeMusicHub = { id: releases ? "ytmusic:new-releases" : "ytmusic:history",
    title: releases ? "New Releases" : "Recently Played Music", category: releases ? "releases" : "recent",
    items: page.items, destination: { browseId }, continuation: page.continuation }
  extraHubs.set(hub.id, hub)
  publishHubs()
}

function fillHomePages() {
  if (homeContinuation) return homeContinuation
  const revision = useYoutubeMusicDiscoveryStore.getState().revision
  const owns = () => useYoutubeMusicDiscoveryStore.getState().connected && useYoutubeMusicDiscoveryStore.getState().revision === revision
  const work = (async () => {
    const visited = new Set<string>()
    for (let count = 0; count < 5 && owns(); count++) {
      const saved = home.read()
      if (!saved || saved.pageCount >= 6) break
      const cursor = saved.next
      if (typeof cursor !== "string" || visited.has(cursor)) break
      visited.add(cursor)
      const page = await browseYoutubeMusic({ browseId: "FEmusic_home" }, cursor)
      if (!owns()) return
      saveHomePage(cursor, page)
    }
  })()
  homeContinuation = work
  void work.then(() => { if (homeContinuation === work) homeContinuation = null },
    () => { if (homeContinuation === work) homeContinuation = null })
  return work
}

subscribeYoutubeMusicCatalog(update => {
  if (update.params || update.includePerformances) return
  if (update.browseId === "FEmusic_home" && (update.continuation === null || home.has(update.continuation))) {
    saveHomePage(update.continuation, update.page)
    void fillHomePages().catch(() => {})
  } else if (!update.continuation && ["FEmusic_new_releases_albums", "FEmusic_history"].includes(update.browseId)) {
    saveExtraHub(update.browseId, update.page)
  }
})

export function refreshYoutubeMusicDiscovery(force = false) {
  const state = useYoutubeMusicDiscoveryStore.getState()
  if (!state.connected || pending) return pending ?? Promise.resolve()
  const revision = state.revision
  const owns = () => useYoutubeMusicDiscoveryStore.getState().connected && useYoutubeMusicDiscoveryStore.getState().revision === revision
  useYoutubeMusicDiscoveryStore.setState({ loading: true, error: false })
  const work = (async () => {
    const results = await Promise.allSettled([
      (async () => {
        const result = await browseYoutubeMusic({ browseId: "FEmusic_home" }, null, force)
        if (!owns()) return
        saveHomePage(null, result)
        await fillHomePages()
      })(),
      (async () => {
        const destination = { browseId: "FEmusic_new_releases_albums" }
        const page = await browseYoutubeMusic(destination, null, force)
        if (owns()) saveExtraHub(destination.browseId, page)
      })(),
      (async () => {
        const destination = { browseId: "FEmusic_history" }
        const page = await browseYoutubeMusic(destination, null, force)
        if (owns()) saveExtraHub(destination.browseId, page)
      })(),
    ])
    if (owns()) {
      useYoutubeMusicDiscoveryStore.setState({ loading: false, error: results.every(result => result.status === "rejected") })
    }
  })()
  pending = work
  void work.finally(() => { if (pending === work) pending = null })
  return work
}

function receive(status: YoutubeMusicStatus) {
  const previous = useYoutubeMusicDiscoveryStore.getState()
  const switched = previous.accountId != null && status.accountId != null && previous.accountId !== status.accountId
  const connected = status.enabled && (status.phase === "connected" || (status.phase === "refreshing" && previous.connected))
  if (!connected || switched) {
    if (status.phase === "disconnected" && previous.connected) clearYoutubeMusicHistory()
    if (previous.connected || previous.hubs.length) {
      pending = null
      catalogRequests.clear()
      catalogUpdates.clear()
      home = discoveryPages<YoutubeMusicHub>(hub => hub.id)
      extraHubs.clear()
      homeContinuation = null
      useYoutubeMusicDiscoveryStore.setState({ connected: false, accountId: null, hubs: [], revision: previous.revision + 1, loading: false, error: false })
    }
    if (!connected) return
  }
  useYoutubeMusicDiscoveryStore.setState({ connected: true, accountId: status.accountId ?? null })
  void refreshYoutubeMusicDiscovery()
}
function start() {
  if (started) return
  started = true
  let events = 0
  void (async () => {
    await listen<{ accountId: string | null; videoId: string; codec: string | null; bitrate: number | null; formatId: string | null; checkedAt: number }>("ytmusic://audio-format", async event => {
      const format = event.payload
      const owner = useYoutubeMusicDiscoveryStore.getState()
      if (!owner.connected || !owner.accountId || format.accountId !== owner.accountId || !format.codec) return
      const { usePlayerStore } = await import("../../stores/playerStore")
      if (useYoutubeMusicDiscoveryStore.getState().revision !== owner.revision) return
      const patch = (track: import("../../types/music").MusicTrack) => track.id === `ytmusic:${format.videoId}` ? {
        ...track, codec: format.codec, bitrate: format.bitrate,
        mediaInfo: { ...track.mediaInfo, selectedAudio: { codec: format.codec!, bitrate: format.bitrate, formatId: format.formatId, checkedAt: format.checkedAt } },
      } : track
      usePlayerStore.setState(state => ({ currentTrack: state.currentTrack ? patch(state.currentTrack) : null, queue: state.queue.map(patch) }))
    }).catch(() => {})
    await youtubeMusicApi.subscribe(status => { events++; receive(status) })
    const before = events
    const status = await youtubeMusicApi.status()
    if (before === events) receive(status)
  })().catch(() => { started = false })
}
export function useYoutubeMusicDiscovery(revalidateHome = false) {
  useEffect(start, [])
  const state = useYoutubeMusicDiscoveryStore()
  useEffect(() => {
    if (revalidateHome && state.connected) void refreshYoutubeMusicDiscovery()
  }, [revalidateHome, state.connected])
  return state
}

/** Cursor-backed list, also used by the existing mixed-source queue pager. */
export function youtubeMusicCollectionSource(destination: YoutubeMusicDestination,
  initial?: { items: YoutubeMusicItem[]; continuation: string | null }): PagedTrackSource {
  const owner = useYoutubeMusicDiscoveryStore.getState().revision
  if (destination.browseId.startsWith("UC") && !destination.params && !initial) {
    return { key: `ytmusic:${destination.browseId}`, prepare: async () => {
      const page = await browseYoutubeMusic(destination)
      if (!useYoutubeMusicDiscoveryStore.getState().connected || useYoutubeMusicDiscoveryStore.getState().revision !== owner)
        throw Error("YouTube Music connection changed.")
      const songs = page.artist?.songs ?? page.artist?.shuffle
      return songs && (songs.browseId !== destination.browseId || songs.params) ? youtubeMusicCollectionSource(songs)
        : youtubeMusicCollectionSource(destination, { items: page.items, continuation: page.continuation })
    }, loadPage: async () => ({ items: [], total: 0 }) }
  }
  const tracks = initial?.items.filter(item => item.kind === "song").map(youtubeMusicItemTrack) ?? []
  let token = initial?.continuation ?? null, started = !!initial, done = !!initial && !token
  const visited = new Set<string>(initial?.continuation ? [initial.continuation] : [])
  let serial = Promise.resolve()
  return {
    key: `ytmusic:${destination.browseId}`,
    pageSize: 50,
    loadPage: (offset, limit) => {
      const load = async () => {
        const owns = () => useYoutubeMusicDiscoveryStore.getState().connected && useYoutubeMusicDiscoveryStore.getState().revision === owner
        while (!done && tracks.length < offset + limit) {
          if (!owns()) throw Error("YouTube Music connection changed.")
          const page = await browseYoutubeMusic(destination, started ? token : null)
          if (!owns()) throw Error("YouTube Music connection changed.")
          started = true
          tracks.push(...page.items.filter(item => item.kind === "song").map(youtubeMusicItemTrack))
          token = page.continuation
          done = !token || visited.has(token)
          if (token) visited.add(token)
        }
        return { items: tracks.slice(offset, offset + limit), total: tracks.length + (done ? 0 : 1), offset }
      }
      const result = serial.then(load)
      serial = result.then(() => {}, () => {})
      return result
    },
  }
}
