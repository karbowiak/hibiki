/** Artist and album data belongs to one connected provider and library. */
import type { StateStorage } from "zustand/middleware"
import type { MusicProvider } from "../providers/types"
import { ScopedPersistence } from "./scopedPersistence"
import type {
  MusicArtist,
  MusicAlbum,
  MusicTrack,
  MusicHub,
  MusicPlaylist,
} from "../types/music"
import { processArtistAlbums } from "../lib/dedup"
import { loadAlbumContents } from "../lib/albumContents"
import { startTiming } from "../lib/performance"
import { sanitizeOfflineData } from "../offline/providerCache"
const METADATA_RETENTION_MS = 90 * 24 * 60 * 60_000

export interface ArtistCacheEntry {
  artist: MusicArtist
  albums: MusicAlbum[]
  singles: MusicAlbum[]
  popularTracks: MusicTrack[]
  similarArtists: MusicArtist[]
  sonicallySimilar: MusicArtist[]
  relatedHubs: MusicHub[]
  stations: MusicPlaylist[]
  deduplicated: boolean
  fetchedAt: number
  invalidated?: boolean
}
export interface AlbumCacheEntry {
  album: MusicAlbum
  tracks: MusicTrack[]
  relatedHubs: MusicHub[]
  fetchedAt: number
  invalidated?: boolean
  deduplicated?: boolean
}

const EVICT_MS = METADATA_RETENTION_MS
const MAX_ARTISTS = 50
const MAX_ALBUMS = 100
export interface MetadataCacheSession {
  owner: symbol
  provider: MusicProvider
  epoch: number
}
export class MetadataRequestSuperseded extends Error {
  constructor() {
    super("Metadata request was superseded")
  }
}

function evict<T extends { fetchedAt: number }>(
  entries: Record<string, T>,
  max: number,
  keep?: string
): Record<string, T> {
  const now = Date.now()
  return Object.fromEntries(
    Object.entries(entries)
      .filter(
        ([, entry]) =>
          Number.isFinite(entry.fetchedAt) &&
          entry.fetchedAt <= now &&
          now - entry.fetchedAt < EVICT_MS
      )
      .sort(
        (a, b) =>
          Number(b[0] === keep) - Number(a[0] === keep) ||
          b[1].fetchedAt - a[1].fetchedAt
      )
      .slice(0, max)
      .filter(([, entry]) => JSON.stringify(entry).length <= 1024 * 1024)
      .filter((() => { let bytes = 0; return ([, entry]: [string, T]) => (bytes += JSON.stringify(entry).length) <= 8 * 1024 * 1024 })())
  )
}
function item(value: any) {
  return (
    value && typeof value.id === "string" && typeof value.title === "string"
  )
}
function hubs(value: any) {
  return (
    Array.isArray(value) &&
    value.every(
      (hub) =>
        hub &&
        typeof hub.identifier === "string" &&
        Array.isArray(hub.items) &&
        hub.items.every(item)
    )
  )
}
function restoreArtists(value: unknown): Record<string, ArtistCacheEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return evict(
    Object.fromEntries(
      Object.entries(value).filter(([id, entry]) => {
        const data = entry as ArtistCacheEntry
        return (
          data &&
          item(data.artist) &&
          data.artist.id === id &&
          [
            data.albums,
            data.singles,
            data.popularTracks,
            data.similarArtists,
            data.sonicallySimilar,
            data.stations,
          ].every((list) => Array.isArray(list) && list.every(item)) &&
          hubs(data.relatedHubs) &&
          typeof data.deduplicated === "boolean"
        )
      })
    ),
    MAX_ARTISTS
  ) as Record<string, ArtistCacheEntry>
}
function restoreAlbums(value: unknown): Record<string, AlbumCacheEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return evict(
    Object.fromEntries(
      Object.entries(value).filter(([id, entry]) => {
        const data = entry as AlbumCacheEntry
        return (
          data &&
          item(data.album) &&
          data.album.id === id &&
          Array.isArray(data.tracks) &&
          data.tracks.every(item) &&
          hubs(data.relatedHubs)
        )
      })
    ),
    MAX_ALBUMS
  ) as Record<string, AlbumCacheEntry>
}
function unique<T extends { id: string }>(items: T[]) {
  const ids = new Set<string>()
  return items.filter((item) => {
    if (ids.has(item.id)) return false
    ids.add(item.id)
    return true
  })
}

interface MetadataDependencies {
  getProvider(): MusicProvider | null
  storage?: StateStorage
  deduplicate?: () => boolean
}

interface PageRequest<T> {
  deduplicated: boolean
  promise: Promise<T>
  core?: T
  listeners: Set<(entry: T) => void>
}
function joinPage<T>(
  request: PageRequest<T>,
  onCore?: (entry: T) => void
): Promise<T> {
  if (onCore) {
    if (request.core) onCore(request.core)
    else request.listeners.add(onCore)
  }
  return request.promise
}
function publishCore<T>(request: PageRequest<T>, core: T) {
  request.core = core
  for (const listener of request.listeners) listener(core)
  request.listeners.clear()
}

export function createMetadataCache({
  getProvider,
  storage,
  deduplicate = () => true,
}: MetadataDependencies) {
  const persistence = new ScopedPersistence(storage, "hibiki-metadata-v3")
  const owner = Symbol("metadata-cache")
  let epoch = 0,
    provider: MusicProvider | null = null
  let artists: Record<string, ArtistCacheEntry> = {},
    albums: Record<string, AlbumCacheEntry> = {}
  const artistRequests = new Map<string, PageRequest<ArtistCacheEntry>>()
  const albumRequests = new Map<string, PageRequest<AlbumCacheEntry>>()
  const listeners = new Set<(kind: "artist" | "album", id: string) => void>()
  const notify = (kind: "artist" | "album", id: string) => listeners.forEach(listener => listener(kind, id))
  const capture = (candidate = getProvider()): MetadataCacheSession | null =>
    candidate && candidate === provider && getProvider() === candidate
      ? { owner, provider: candidate, epoch }
      : null
  const current = (session: MetadataCacheSession | null) =>
    !!session &&
    session.owner === owner &&
    session.epoch === epoch &&
    session.provider === provider &&
    getProvider() === provider
  const check = (session: MetadataCacheSession | null) => {
    if (!current(session)) throw new MetadataRequestSuperseded()
  }
  const save = () => persistence.save({ policyVersion: 1, artists: sanitizeOfflineData(artists), albums: sanitizeOfflineData(albums) })
  const retire = () => {
    epoch++
    artistRequests.clear()
    albumRequests.clear()
    artists = {}
    albums = {}
  }

  const getArtist = (id: string, shouldDeduplicate = deduplicate()) => {
    if (!capture()) return undefined
    const entry = artists[id]
    return entry &&
      entry.deduplicated === shouldDeduplicate &&
      Date.now() - entry.fetchedAt < EVICT_MS
      ? entry
      : undefined
  }
  const getAlbum = (id: string) => {
    if (!capture()) return undefined
    const entry = albums[id]
    return entry &&
      ((!entry.album.artistId && entry.deduplicated === undefined) ||
        entry.deduplicated === deduplicate()) &&
      Date.now() - entry.fetchedAt < EVICT_MS
      ? entry
      : undefined
  }

  function loadArtist(
    id: string,
    opts: {
      force?: boolean
      deduplicate?: boolean
      onCore?: (entry: ArtistCacheEntry) => void
    } = {}
  ): Promise<ArtistCacheEntry> {
    const session = capture(),
      shouldDeduplicate = opts.deduplicate ?? deduplicate()
    if (!session) return Promise.reject(new MetadataRequestSuperseded())
    const cached = getArtist(id, shouldDeduplicate)
    const existing = artistRequests.get(id)
    if (!opts.force && existing?.deduplicated === shouldDeduplicate)
      return joinPage(existing, opts.onCore)
    const request: PageRequest<ArtistCacheEntry> = {
      deduplicated: shouldDeduplicate,
      promise: Promise.resolve(null as unknown as ArtistCacheEntry),
      listeners: new Set(opts.onCore ? [opts.onCore] : []),
    }
    artistRequests.set(id, request)
    const valid = () => {
      check(session)
      if (artistRequests.get(id) !== request)
        throw new MetadataRequestSuperseded()
    }
    request.promise = (async () => {
      valid()
      const timing = startTiming("artistPage")
      try {
        const p = session.provider
        const recommendations = Promise.all([
          p.getArtistSimilar(id).catch(() => []),
          p.getArtistSonicallySimilar
            ? p.getArtistSonicallySimilar(id, 20).catch(() => [])
            : Promise.resolve([]),
          p.getRelatedHubs(id).catch(() => []),
          p.getArtistStations
            ? p.getArtistStations(id).catch(() => [])
            : Promise.resolve([]),
        ])
        const [artist, allAlbums, singleList, tracks] = await Promise.all([
          p.getArtist(id),
          (p.getArtistAlbumsInSection
            ? p.getArtistAlbumsInSection(id)
            : p.getArtistAlbums(id)
          ).catch((error) => {
            if (p.isOffline) return []
            throw error
          }),
          (p.getArtistAlbumsInSection
            ? p.getArtistAlbumsInSection(id, "EP,Single")
            : Promise.resolve([])
          ).catch((error) => {
            if (p.isOffline) return []
            throw error
          }),
          p.isOffline && p.getArtistTracks
            ? p.getArtistTracks(id)
            : p.getArtistPopularTracksInSection
              ? p.getArtistPopularTracksInSection(id, 15)
              : p.getArtistPopularTracks(id, 15),
        ])
        timing.phase("core")
        valid()
        if (artist.id !== id)
          throw new Error("Server returned a different artist")
        const lists = processArtistAlbums(
          allAlbums,
          singleList,
          shouldDeduplicate
        )
        const core: ArtistCacheEntry = {
          artist,
          albums: lists.albums,
          singles: lists.singles,
          popularTracks: unique(tracks),
          similarArtists: cached?.similarArtists ?? [],
          sonicallySimilar: cached?.sonicallySimilar ?? [],
          relatedHubs: cached?.relatedHubs ?? [],
          stations: cached?.stations ?? [],
          deduplicated: shouldDeduplicate,
          fetchedAt: Date.now(),
        }
        artists = evict({ ...artists, [id]: core }, MAX_ARTISTS, id)
        save()
        notify("artist", id)
        publishCore(request, core)
        const [similarArtists, sonicallySimilar, relatedHubs, stations] =
          await recommendations
        valid()
        timing.phase("recommendations")
        const entry = {
          ...core,
          similarArtists,
          sonicallySimilar,
          relatedHubs,
          stations,
        }
        artists = evict({ ...artists, [id]: entry }, MAX_ARTISTS, id)
        save()
        notify("artist", id)
        return entry
      } finally {
        timing.end("load")
      }
    })().finally(() => {
      if (artistRequests.get(id) === request) artistRequests.delete(id)
    })
    if (!opts.force && cached) {
      if (opts.onCore) void request.promise.then(opts.onCore).catch(() => {})
      void request.promise.catch(() => {})
      return Promise.resolve(cached)
    }
    return request.promise
  }

  function loadAlbum(
    id: string,
    opts: { force?: boolean; onCore?: (entry: AlbumCacheEntry) => void } = {}
  ): Promise<AlbumCacheEntry> {
    const session = capture()
    const shouldDeduplicate = deduplicate()
    if (!session) return Promise.reject(new MetadataRequestSuperseded())
    const cached = getAlbum(id)
    const existing = albumRequests.get(id)
    if (!opts.force && existing?.deduplicated === shouldDeduplicate)
      return joinPage(existing, opts.onCore)
    const request: PageRequest<AlbumCacheEntry> = {
      deduplicated: shouldDeduplicate,
      promise: Promise.resolve(null as unknown as AlbumCacheEntry),
      listeners: new Set(opts.onCore ? [opts.onCore] : []),
    }
    albumRequests.set(id, request)
    request.promise = (async () => {
      check(session)
      if (albumRequests.get(id) !== request) throw new MetadataRequestSuperseded()
      const timing = startTiming("albumPage")
      try {
        const p = session.provider
        const related = p.getRelatedHubs(id).catch(() => [])
        const { album, tracks } = await loadAlbumContents(
          p,
          id,
          shouldDeduplicate
        )
        timing.phase("core")
        check(session)
        if (albumRequests.get(id) !== request)
          throw new MetadataRequestSuperseded()
        if (album.id !== id)
          throw new Error("Server returned a different album")
        const core = {
          album,
          tracks,
          relatedHubs: cached?.relatedHubs ?? [],
          fetchedAt: Date.now(),
          deduplicated: shouldDeduplicate,
        }
        albums = evict({ ...albums, [id]: core }, MAX_ALBUMS, id)
        save()
        notify("album", id)
        publishCore(request, core)
        const relatedHubs = await related
        check(session)
        if (albumRequests.get(id) !== request)
          throw new MetadataRequestSuperseded()
        timing.phase("recommendations")
        const entry = { ...core, relatedHubs }
        albums = evict({ ...albums, [id]: entry }, MAX_ALBUMS, id)
        save()
        notify("album", id)
        return entry
      } finally {
        timing.end("load")
      }
    })().finally(() => {
      if (albumRequests.get(id) === request) albumRequests.delete(id)
    })
    if (!opts.force && cached) {
      if (opts.onCore) void request.promise.then(opts.onCore).catch(() => {})
      void request.promise.catch(() => {})
      return Promise.resolve(cached)
    }
    return request.promise
  }

  return {
    capture,
    current,
    getArtist,
    getAlbum,
    loadArtist,
    loadAlbum,
    subscribe: (listener: (kind: "artist" | "album", id: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    parents: (kind: "artist" | "album" | "track", id: string) => {
      const albumIds = new Set<string>(), artistIds = new Set<string>()
      for (const [key, entry] of Object.entries(albums)) {
        if (kind === "album" && (key === id || entry.album._alternateIds?.includes(id)) || kind === "track" && entry.tracks.some(track => track.id === id)) {
          albumIds.add(key); if (entry.album.artistId) artistIds.add(entry.album.artistId)
        }
      }
      for (const [key, entry] of Object.entries(artists)) {
        if (kind === "album" && [...entry.albums, ...entry.singles].some(album => album.id === id || album._alternateIds?.includes(id)) ||
          kind === "track" && entry.popularTracks.some(track => track.id === id)) artistIds.add(key)
      }
      return { albums: [...albumIds], artists: [...artistIds] }
    },
    expire: (kind?: "artist" | "album" | "track", id?: string, removed = false) => {
      persistence.cancelHydration()
      for (const [key, entry] of Object.entries(albums)) {
        const related = !kind || kind === "album" && (key === id || entry.album._alternateIds?.includes(id!)) ||
          kind === "artist" && entry.album.artistId === id || kind === "track" && entry.tracks.some(track => track.id === id)
        if (!related) continue
        albumRequests.delete(key)
        albums[key] = { ...entry, invalidated: true, tracks: removed && kind === "track" ? entry.tracks.filter(track => track.id !== id) : entry.tracks }
        notify("album", key)
      }
      for (const [key, entry] of Object.entries(artists)) {
        const related = !kind || kind === "artist" && key === id || kind === "album" && [...entry.albums,...entry.singles].some(album => album.id === id) || kind === "track" && entry.popularTracks.some(track => track.id === id)
        if (!related) continue
        artistRequests.delete(key)
        artists[key] = { ...entry, invalidated: true,
          albums: removed && kind === "album" ? entry.albums.filter(album => album.id !== id) : entry.albums,
          singles: removed && kind === "album" ? entry.singles.filter(album => album.id !== id) : entry.singles,
          popularTracks: removed && kind === "track" ? entry.popularTracks.filter(track => track.id !== id) : entry.popularTracks }
        notify("artist", key)
      }
      save()
    },
    refresh: (method: string, args: unknown[], payload: unknown) => {
      const id = String(args[0] ?? "")
      if (method === "getArtist" && artists[id])
        artists[id] = { ...artists[id], artist: payload as MusicArtist }
      else if (
        (method === "getAlbum" || method === "getAlbumTracks") &&
        albums[id]
      ) {
        if (albums[id].album._alternateIds?.length) {
          // A raw refresh describes just one physical copy. It cannot replace
          // the merged page. An in-flight full composition will refresh it;
          // otherwise expire it for the next load instead of losing tracks.
          if (!albumRequests.has(id))
            albums[id] = { ...albums[id], invalidated: true }
        } else if (method === "getAlbum")
          albums[id] = { ...albums[id], album: payload as MusicAlbum }
        else albums[id] = { ...albums[id], tracks: payload as MusicTrack[] }
      } else if (
        (method === "getArtistPopularTracks" ||
          method === "getArtistPopularTracksInSection") &&
        artists[id]
      )
        artists[id] = { ...artists[id], popularTracks: payload as MusicTrack[] }
      else if (
        (method === "getArtistAlbums" ||
          method === "getArtistAlbumsInSection") &&
        artists[id]
      ) {
        const entry = artists[id]
        const lists = args[1]
          ? processArtistAlbums(
              [...entry.albums, ...entry.singles],
              payload as MusicAlbum[],
              entry.deduplicated
            )
          : processArtistAlbums(
              payload as MusicAlbum[],
              entry.singles,
              entry.deduplicated
            )
        artists[id] = { ...entry, ...lists }
      } else if (method === "getRelatedHubs" && albums[id])
        albums[id] = { ...albums[id], relatedHubs: payload as MusicHub[] }
      else if (method === "getRelatedHubs" && artists[id])
        artists[id] = { ...artists[id], relatedHubs: payload as MusicHub[] }
      else if (method === "getArtistSimilar" && artists[id])
        artists[id] = {
          ...artists[id],
          similarArtists: payload as MusicArtist[],
        }
      else if (method === "getArtistStations" && artists[id])
        artists[id] = { ...artists[id], stations: payload as MusicPlaylist[] }
      else return false
      save()
      notify(artists[id] ? "artist" : "album", id)
      return true
    },
    invalidate: (kind: "artist" | "album", id: string) => {
      if (!capture()) return
      persistence.cancelHydration()
      if (kind === "artist") {
        artistRequests.delete(id)
        delete artists[id]
        // Album cards retain their artist name; discard those derived entries.
        for (const [key, entry] of Object.entries(albums)) {
          if (entry.album.artistId === id) {
            albumRequests.delete(key)
            delete albums[key]
          }
        }
      } else {
        albumRequests.delete(id)
        delete albums[id]
        for (const [key, entry] of Object.entries(albums)) {
          if (entry.album._alternateIds?.includes(id)) {
            albumRequests.delete(key)
            delete albums[key]
          }
        }
        // Any in-flight artist response may contain the edited album.
        artistRequests.clear()
        for (const [key, entry] of Object.entries(artists)) {
          if (
            [...entry.albums, ...entry.singles].some(
              (album) => album.id === id || album._alternateIds?.includes(id)
            )
          )
            delete artists[key]
        }
      }
      save()
    },
    activate: async (next: MusicProvider) => {
      const loading = persistence.activate(next.cacheScope ?? null)
      retire()
      provider = next
      const activation = epoch
      const saved = (await loading) as
        { artists?: unknown; albums?: unknown } | undefined
      if (activation !== epoch || provider !== next) return
      // Hydrate offline pages through the saved provider's file availability
      // projection, rather than reusing online DTOs with stale/absent flags.
      if (next.isOffline) return
      artists = evict(
        { ...restoreArtists(saved?.artists), ...artists },
        MAX_ARTISTS
      )
      albums = evict({ ...restoreAlbums(saved?.albums), ...albums }, MAX_ALBUMS)
      save()
    },
    disconnect: () => {
      void persistence.activate(null)
      retire()
      provider = null
    },
    clear: () => {
      persistence.cancelHydration()
      retire()
      save()
    },
    stats: () =>
      capture()
        ? {
            artistCount: Object.keys(artists).length,
            albumCount: Object.keys(albums).length,
          }
        : { artistCount: 0, albumCount: 0 },
    prefetchArtist: (id: string) => {
      void loadArtist(id).catch(() => {})
    },
    prefetchAlbum: (id: string) => {
      void loadAlbum(id).catch(() => {})
    },
  }
}
