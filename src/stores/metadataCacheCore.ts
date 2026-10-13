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
}
export interface AlbumCacheEntry {
  album: MusicAlbum
  tracks: MusicTrack[]
  relatedHubs: MusicHub[]
  fetchedAt: number
}

const STALE_MS = 30 * 60_000
const EVICT_MS = 24 * 60 * 60_000
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
  const artistRequests = new Map<
    string,
    { deduplicated: boolean; promise: Promise<ArtistCacheEntry> }
  >()
  const albumRequests = new Map<string, Promise<AlbumCacheEntry>>()
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
  const save = () => persistence.save({ artists, albums })
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
    return entry && Date.now() - entry.fetchedAt < EVICT_MS ? entry : undefined
  }

  function loadArtist(
    id: string,
    opts: { force?: boolean; deduplicate?: boolean } = {}
  ): Promise<ArtistCacheEntry> {
    const session = capture(),
      shouldDeduplicate = opts.deduplicate ?? deduplicate()
    if (!session) return Promise.reject(new MetadataRequestSuperseded())
    const cached = getArtist(id, shouldDeduplicate)
    if (!opts.force && cached && Date.now() - cached.fetchedAt < STALE_MS)
      return Promise.resolve(cached)
    const existing = artistRequests.get(id)
    if (!opts.force && existing?.deduplicated === shouldDeduplicate)
      return existing.promise
    const request = {
      deduplicated: shouldDeduplicate,
      promise: Promise.resolve(null as unknown as ArtistCacheEntry),
    }
    artistRequests.set(id, request)
    const valid = () => {
      check(session)
      if (artistRequests.get(id) !== request)
        throw new MetadataRequestSuperseded()
    }
    request.promise = (async () => {
      const p = session.provider
      const [
        artist,
        allAlbums,
        singleList,
        tracks,
        similarArtists,
        sonicallySimilar,
        relatedHubs,
        stations,
      ] = await Promise.all([
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
        p.getArtistSimilar(id).catch(() => []),
        p.getArtistSonicallySimilar
          ? p.getArtistSonicallySimilar(id, 20).catch(() => [])
          : Promise.resolve([]),
        p.getRelatedHubs(id).catch(() => []),
        p.getArtistStations
          ? p.getArtistStations(id).catch(() => [])
          : Promise.resolve([]),
      ])
      valid()
      if (artist.id !== id)
        throw new Error("Server returned a different artist")
      const lists = processArtistAlbums(
        allAlbums,
        singleList,
        shouldDeduplicate
      )
      const entry = {
        artist,
        albums: lists.albums,
        singles: lists.singles,
        popularTracks: unique(tracks),
        similarArtists,
        sonicallySimilar,
        relatedHubs,
        stations,
        deduplicated: shouldDeduplicate,
        fetchedAt: Date.now(),
      }
      artists = evict({ ...artists, [id]: entry }, MAX_ARTISTS, id)
      save()
      return entry
    })().finally(() => {
      if (artistRequests.get(id) === request) artistRequests.delete(id)
    })
    return request.promise
  }

  function loadAlbum(
    id: string,
    opts: { force?: boolean } = {}
  ): Promise<AlbumCacheEntry> {
    const session = capture()
    if (!session) return Promise.reject(new MetadataRequestSuperseded())
    const cached = getAlbum(id)
    if (!opts.force && cached && Date.now() - cached.fetchedAt < STALE_MS)
      return Promise.resolve(cached)
    const existing = albumRequests.get(id)
    if (!opts.force && existing) return existing
    const request = (async () => {
      const [album, tracks, relatedHubs] = await Promise.all([
        session.provider.getAlbum(id),
        session.provider.getAlbumTracks(id),
        session.provider.getRelatedHubs(id).catch(() => []),
      ])
      check(session)
      if (albumRequests.get(id) !== request)
        throw new MetadataRequestSuperseded()
      if (album.id !== id) throw new Error("Server returned a different album")
      const entry = { album, tracks, relatedHubs, fetchedAt: Date.now() }
      albums = evict({ ...albums, [id]: entry }, MAX_ALBUMS, id)
      save()
      return entry
    })().finally(() => {
      if (albumRequests.get(id) === request) albumRequests.delete(id)
    })
    albumRequests.set(id, request)
    return request
  }

  return {
    capture,
    current,
    getArtist,
    getAlbum,
    loadArtist,
    loadAlbum,
    refresh: (method: string, args: unknown[], payload: unknown) => {
      const id = String(args[0] ?? "")
      if (method === "getArtist" && artists[id])
        artists[id] = { ...artists[id], artist: payload as MusicArtist }
      else if (method === "getAlbum" && albums[id])
        albums[id] = { ...albums[id], album: payload as MusicAlbum }
      else if (method === "getAlbumTracks" && albums[id])
        albums[id] = { ...albums[id], tracks: payload as MusicTrack[] }
      else if (
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
        // Any in-flight artist response may contain the edited album.
        artistRequests.clear()
        for (const [key, entry] of Object.entries(artists)) {
          if (
            [...entry.albums, ...entry.singles].some((album) => album.id === id)
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
