import { useEffect } from "react"
import { create } from "zustand"
import { useUIStore } from "../../stores/uiStore"
import { browseYoutubeMusic, subscribeYoutubeMusicCatalog, useYoutubeMusicDiscovery, useYoutubeMusicDiscoveryStore, type YoutubeMusicBrowsePage, type YoutubeMusicItem } from "./discovery"
import { discoveryPages } from "../../lib/discoveryPages"
import { useYoutubeMusicLikesStore } from "./likes"
import type { MusicTrack } from "../../types/music"

export type YoutubeMusicLibraryKind = "playlists" | "songs" | "albums" | "artists"
const destinations = {
  playlists: "FEmusic_liked_playlists",
  songs: "VLLM",
  albums: "FEmusic_liked_albums",
  artists: "FEmusic_library_corpus_artists",
} as const
interface Collection {
  items: YoutubeMusicItem[]
  continuation: string | null
  initialized: boolean
  loading: boolean
  error: boolean
  checked: number
  refresh: number
  version: number
}
const empty = (): Collection => ({ items: [], continuation: null, initialized: false, loading: false, error: false, checked: 0, refresh: -1, version: 0 })
const collections = () => ({ playlists: empty(), songs: empty(), albums: empty(), artists: empty() })
export const useYoutubeMusicLibraryStore = create<Record<YoutubeMusicLibraryKind, Collection>>(collections)
const pending = new Map<YoutubeMusicLibraryKind, Promise<void>>()
let songsDirty = false
const createPages = () => discoveryPages<YoutubeMusicItem>(item => item.id)
const pages = { playlists: createPages(), songs: createPages(), albums: createPages(), artists: createPages() }

function songItem(track: MusicTrack): YoutubeMusicItem {
  const original = (track._providerData as { youtubeMusic?: YoutubeMusicItem } | null)?.youtubeMusic
  let thumbnail = original?.thumbnail ?? null
  if (!thumbnail && track.thumbUrl) {
    try {
      const url = new URL(track.thumbUrl)
      thumbnail = url.searchParams.get("src") ?? (url.protocol === "https:" ? track.thumbUrl : null)
    } catch { /* Restored metadata can omit artwork. */ }
  }
  return { ...original, id: track.id.slice(8), kind: "song", title: track.title, artist: track.artistName,
    album: track.albumName || null, year: track.year || null, thumbnail, liked: true,
    duration: original?.duration ?? `${Math.floor(track.duration / 60000)}:${String(Math.floor(track.duration / 1000) % 60).padStart(2, "0")}`,
    albumId: track.albumId?.startsWith("ytmusic:") ? track.albumId.slice(8) : original?.albumId,
    artistId: track.artistId?.startsWith("ytmusic:") ? track.artistId.slice(8) : original?.artistId }
}

function songLikes(items: YoutubeMusicItem[]) {
  const changes = useYoutubeMusicLikesStore.getState().entries
  const result = items.filter(item => !(changes[`ytmusic:${item.id}`]?.manual && changes[`ytmusic:${item.id}`]?.liked === false))
  const known = new Set(result.map(item => item.id))
  const added: YoutubeMusicItem[] = []
  for (const [id, change] of Object.entries(changes)) {
    if (change.manual && change.liked && change.track && !known.has(id.slice(8))) {
      added.push(songItem(change.track)); known.add(id.slice(8))
    }
  }
  return [...added.reverse(), ...result]
}

useYoutubeMusicLikesStore.subscribe((state, previous) => {
  if (state.owner === null || state.entries === previous.entries) return
  const changed = Object.entries(state.entries).some(([id, entry]) => {
    const old = previous.entries[id]
    return (entry.manual || old?.manual) && (entry.manual !== old?.manual || entry.liked !== old?.liked)
  })
  if (changed) {
    const collection = useYoutubeMusicLibraryStore.getState().songs
    useYoutubeMusicLibraryStore.setState({ songs: { ...collection, items: songLikes(pages.songs.read()?.items ?? []) } })
  }
  const saved = Object.entries(state.entries).some(([id, entry]) =>
    previous.entries[id]?.saving && !entry.saving && entry.manual && !entry.error)
  if (saved) songsDirty = true
})

function savePage(kind: YoutubeMusicLibraryKind, cursor: string | null, page: YoutubeMusicBrowsePage, background = false) {
  const expected = kind === "playlists" ? "playlist" : kind === "songs" ? "song" : kind === "albums" ? "album" : "artist"
  pages[kind].set(cursor, { items: page.items.filter(item => item.kind === expected && item.id !== "VLLM"), next: page.continuation ?? undefined })
  const result = pages[kind].read()
  if (!result) return
  const saved = useYoutubeMusicLibraryStore.getState()[kind]
  useYoutubeMusicLibraryStore.setState({ [kind]: { ...saved, items: kind === "songs" ? songLikes(result.items) : result.items,
    continuation: typeof result.next === "string" ? result.next : null,
    initialized: true, error: false, checked: Date.now(), refresh: useUIStore.getState().pageRefreshKey,
    version: saved.version + (background && cursor === null ? 1 : 0),
  } })
}

subscribeYoutubeMusicCatalog(update => {
  if (update.params || update.includePerformances) return
  const kind = (Object.keys(destinations) as YoutubeMusicLibraryKind[]).find(kind => destinations[kind] === update.browseId)
  if (!kind || (!useYoutubeMusicLibraryStore.getState()[kind].initialized && !pending.has(kind)) ||
    (update.continuation !== null && !pages[kind].has(update.continuation))) return
  savePage(kind, update.continuation, update.page, true)
})

useYoutubeMusicDiscoveryStore.subscribe((state, previous) => {
  if (state.revision !== previous.revision || (!state.connected && previous.connected)) {
    pending.clear()
    songsDirty = false
    for (const kind of Object.keys(pages) as YoutubeMusicLibraryKind[]) pages[kind] = createPages()
    useYoutubeMusicLibraryStore.setState(collections())
  }
})

function load(kind: YoutubeMusicLibraryKind, reset = false, force = false): Promise<void> {
  const connection = useYoutubeMusicDiscoveryStore.getState()
  if (!connection.connected) return Promise.resolve()
  const existing = pending.get(kind)
  if (existing) return existing
  const collection = useYoutubeMusicLibraryStore.getState()[kind]
  if (!reset && collection.initialized && !collection.continuation) return Promise.resolve()
  const revision = connection.revision
  const likeMutation = useYoutubeMusicLikesStore.getState().mutation
  const owns = () => useYoutubeMusicDiscoveryStore.getState().connected && useYoutubeMusicDiscoveryStore.getState().revision === revision
  const cursor = reset ? null : collection.continuation
  useYoutubeMusicLibraryStore.setState({ [kind]: { ...collection, loading: true, error: false } })
  const work = (async () => {
    try {
      const page = await browseYoutubeMusic({ browseId: destinations[kind] }, cursor, force)
      if (!owns()) return
      const resetSongs = kind === "songs" && cursor === null && (force || songsDirty) &&
        useYoutubeMusicLikesStore.getState().mutation === likeMutation
      if (resetSongs) { pages.songs = createPages(); songsDirty = false }
      savePage(kind, cursor, page, force || resetSongs)
      useYoutubeMusicLibraryStore.setState({ [kind]: { ...useYoutubeMusicLibraryStore.getState()[kind], loading: false } })
    } catch {
      if (owns()) useYoutubeMusicLibraryStore.setState({ [kind]: { ...useYoutubeMusicLibraryStore.getState()[kind], loading: false, error: true } })
    }
  })()
  pending.set(kind, work)
  void work.finally(() => { if (pending.get(kind) === work) pending.delete(kind) })
  return work
}

/** Explicit full-collection preparation, used only by the Liked Songs view. */
export async function loadAllYoutubeMusicLibrary(kind: YoutubeMusicLibraryKind, active: () => boolean) {
  const revision = useYoutubeMusicDiscoveryStore.getState().revision
  const refresh = useUIStore.getState().pageRefreshKey
  const owns = () => active() && useYoutubeMusicDiscoveryStore.getState().connected &&
    useYoutubeMusicDiscoveryStore.getState().revision === revision && useUIStore.getState().pageRefreshKey === refresh
  if (!owns()) return
  await load(kind)
  const cursors = new Set<string>()
  while (owns()) {
    const saved = useYoutubeMusicLibraryStore.getState()[kind]
    if (saved.error || !saved.continuation || cursors.has(saved.continuation)) return
    cursors.add(saved.continuation)
    await load(kind)
  }
}

export function useYoutubeMusicLibrary(kind: YoutubeMusicLibraryKind) {
  const connection = useYoutubeMusicDiscovery()
  const collection = useYoutubeMusicLibraryStore(state => state[kind])
  const refresh = useUIStore(state => state.pageRefreshKey)
  useEffect(() => {
    if (!connection.connected) return
    const saved = useYoutubeMusicLibraryStore.getState()[kind]
    const force = saved.initialized && saved.refresh !== refresh
    let active = true
    void (async () => {
      await load(kind, true, force)
      // Playlists populate the sortable sidebar completely; large song/album
      // collections are paged by their views rather than scanned at startup.
      for (let page = 0; kind === "playlists" && active && page < 100; page++) {
        const state = useYoutubeMusicLibraryStore.getState()[kind]
        if (!state.continuation || state.error) break
        await load(kind)
      }
    })()
    return () => { active = false }
  }, [kind, connection.connected, connection.revision, refresh, collection.version])
  return { ...collection, connected: connection.connected,
    more: !!collection.continuation, loadMore: () => load(kind), retry: () => load(kind, !collection.initialized, true) }
}
