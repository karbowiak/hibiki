import type { MusicProvider } from "../providers/types"

export interface OfflineSnapshot {
  payload: unknown
  cachedAt: number
}
export interface OfflineCache {
  get(key: string): Promise<OfflineSnapshot | null>
  put(key: string, payload: unknown): Promise<void>
  invalidate?(prefixes: string[]): Promise<void>
}
export interface OfflineReadNotice {
  key: string
  cachedAt: number
}
const reads = new Set([
  "search",
  "getRecentlyAdded",
  "getLatestReleases",
  "getHubs",
  "getTrack",
  "getAlbum",
  "getArtist",
  "getAlbumTracks",
  "getArtistAlbums",
  "getArtistPopularTracks",
  "getArtistSimilar",
  "getRelatedHubs",
  "getPlaylists",
  "getPlaylistItems",
  "getLikedTracks",
  "getLikedAlbums",
  "getLikedArtists",
  "getTags",
  "getItemsByTag",
  "getMixTracks",
  "getSectionStations",
  "getArtistStations",
  "getAllArtists",
  "getAllAlbums",
  "getAllTracks",
  "getArtistPopularTracksInSection",
  "getArtistAlbumsInSection",
])

const mutations = new Set([
  "createPlaylist",
  "addToPlaylist",
  "removeFromPlaylist",
  "deletePlaylist",
  "editPlaylist",
  "movePlaylistItem",
  "rate",
  "editMetadata",
  "editAdvancedMetadata",
  "saveArtwork",
  "markPlayed",
])
export function offlinePrefix(method: string, itemId?: string): string {
  return itemId === undefined
    ? JSON.stringify(["v1", method]).slice(0, -1) + ","
    : JSON.stringify(["v1", method, [itemId]]).slice(0, -2)
}
export function mutationPrefixes(method: string, args: unknown[]): string[] {
  const prefixes = [offlinePrefix("getHubs")]
  const id = typeof args[0] === "string" ? args[0] : undefined
  if (method.includes("Playlist")) {
    prefixes.push(offlinePrefix("getPlaylists"))
    if (id && method !== "createPlaylist")
      prefixes.push(offlinePrefix("getPlaylistItems", id))
  } else if (method === "rate" || method === "markPlayed") {
    for (const detail of ["getTrack", "getAlbum", "getArtist"])
      prefixes.push(offlinePrefix(detail, id))
    for (const collection of [
      "getLikedTracks",
      "getLikedAlbums",
      "getLikedArtists",
      "getRecentlyAdded",
      "getLatestReleases",
      "getArtistAlbums",
      "getArtistAlbumsInSection",
    ])
      prefixes.push(offlinePrefix(collection))
  } else if (
    method === "editMetadata" ||
    method === "editAdvancedMetadata" ||
    method === "saveArtwork"
  ) {
    const kind = args[0] === "artist" ? "getArtist" : "getAlbum"
    prefixes.push(
      offlinePrefix(kind, typeof args[1] === "string" ? args[1] : undefined)
    )
    for (const collection of [
      "getArtistAlbums",
      "getArtistAlbumsInSection",
      "getAllArtists",
      "getAllAlbums",
      "getAllTracks",
      "getRecentlyAdded",
      "getLatestReleases",
      "getRelatedHubs",
      "getArtistSimilar",
    ])
      prefixes.push(offlinePrefix(collection))
  }
  return [...new Set(prefixes)]
}

/** Exact paging/filter identity; undefined and null are intentionally distinct. */
export function offlineKey(method: string, args: unknown[]): string {
  function encode(value: unknown): unknown {
    if (value === undefined) return { $undefined: true }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (Array.isArray(value)) return value.map(encode)
    throw new Error("Unsupported saved browsing arguments")
  }
  const key = JSON.stringify(["v1", method, args.map(encode)])
  if (new TextEncoder().encode(key).length > 512)
    throw new Error("Saved browsing key exceeds its limit")
  return key
}

/** Opaque provider payloads and playback URLs must never become browsing storage. */
export function sanitizeOfflineData(value: unknown, depth = 0): unknown {
  if (depth > 24) throw new Error("Saved browsing data is too deeply nested")
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value))
    return value.map((item) => sanitizeOfflineData(item, depth + 1))
  if (typeof value === "object" && value) {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.replace(/[_-]/g, "").toLowerCase()
      if (
        [
          "providerdata",
          "token",
          "accesstoken",
          "authorization",
          "password",
          "secret",
          "apikey",
        ].includes(normalized) ||
        item === undefined
      )
        continue
      result[key] =
        normalized === "streamurl" ? null : sanitizeOfflineData(item, depth + 1)
    }
    return result
  }
  throw new Error("Unsupported saved browsing data")
}

export function isUnavailable(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ""
  if (
    /\b(401|403|404)\b|unauthorized|forbidden|superseded|permission/i.test(
      message
    )
  )
    return false
  return /network|offline|connect|timed?\s*out|timeout|fetch failed|request failed|\b(502|503|504)\b/i.test(
    message
  )
}

/** Explicit post-write ambiguity takes precedence over generic permission hints. */
export function isUnconfirmedWrite(error: unknown): boolean {
  if (error && typeof error === "object") {
    const outcome = (error as { outcome?: unknown; code?: unknown }).outcome
    const code = (error as { code?: unknown }).code
    if (
      outcome === "unknown" ||
      outcome === "unconfirmed" ||
      code === "unknown_outcome" ||
      code === "unconfirmed_write"
    )
      return true
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ""
  return /did not confirm|may have|unknown (?:write )?outcome|outcome (?:is )?unknown/i.test(
    message
  )
}

type PlaylistReads = Pick<MusicProvider, "getPlaylists" | "getPlaylistItems">
const freshReads = new WeakMap<MusicProvider, PlaylistReads>()

/** Sync must never treat saved browsing data as a fresh server snapshot. */
export function freshPlaylistReads(provider: MusicProvider): PlaylistReads {
  if (provider.isOffline)
    throw new Error("Reconnect to read the current playlist before syncing.")
  return (
    freshReads.get(provider) ?? {
      getPlaylists: provider.getPlaylists.bind(provider),
      getPlaylistItems: provider.getPlaylistItems.bind(provider),
    }
  )
}

/** Wrap reads only. Native authorization still fences every cache IPC. */
export function createOfflineProvider<T extends MusicProvider>(
  provider: T,
  cache: OfflineCache,
  options: {
    owns?: () => boolean
    onOfflineRead?: (notice: OfflineReadNotice) => void
    onOnlineRead?: (key: string) => void
    unavailable?: (error: unknown) => boolean
  } = {}
): T {
  const methods = new Map<PropertyKey, unknown>()
  const versions = new Map<string, number>()
  const initialScope = provider.cacheScope
  const initialSession = provider.playbackSession
  let requestSequence = 0
  let writes: Promise<void> = Promise.resolve()
  let cacheEpoch = 0
  let fallbackSafe = true
  const proxy = new Proxy(provider, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (methods.has(property)) return methods.get(property)
      const bound = value.bind(target)
      if (typeof property === "string" && mutations.has(property)) {
        const mutation = async (...args: unknown[]) => {
          const scope = target.cacheScope
          const session = target.playbackSession
          const ownsMutation = () =>
            !!scope &&
            scope === initialScope &&
            target.cacheScope === scope &&
            target.playbackSession === session &&
            session === initialSession &&
            (options.owns?.() ?? true)
          if ((initialScope || scope) && !ownsMutation())
            throw new Error("Saved library request was superseded")
          const invalidateOwned = async () => {
            if (!ownsMutation()) return
            cacheEpoch++
            const invalidation = writes.then(async () => {
              if (!ownsMutation()) return
              if (!cache.invalidate) {
                fallbackSafe = false
                return
              }
              try {
                await cache.invalidate(mutationPrefixes(property, args))
              } catch {
                fallbackSafe = false
              }
            })
            writes = invalidation.catch(() => {})
            await invalidation
          }
          let result: unknown
          try {
            result = await bound(...args)
          } catch (error) {
            if (isUnconfirmedWrite(error)) await invalidateOwned()
            throw error
          }
          await invalidateOwned()
          return result
        }
        methods.set(property, mutation)
        return mutation
      }
      if (typeof property !== "string" || !reads.has(property)) {
        methods.set(property, bound)
        return bound
      }
      const wrapped = async (...args: unknown[]) => {
        const scope = target.cacheScope
        const session = target.playbackSession
        const current = () =>
          !!scope &&
          target.cacheScope === scope &&
          scope === initialScope &&
          target.playbackSession === session &&
          session === initialSession &&
          (options.owns?.() ?? true)
        const check = () => {
          if (!current())
            throw new Error("Saved library request was superseded")
        }
        // Unscoped providers retain their existing behavior and never persist.
        if (!scope) return bound(...args)
        const key = offlineKey(property, args)
        const readEpoch = cacheEpoch
        const version = ++requestSequence
        versions.set(key, version)
        try {
          check()
          let result: unknown
          try {
            result = await bound(...args)
          } catch (error) {
            check()
            await writes
            check()
            if (readEpoch !== cacheEpoch)
              throw new Error("Saved library request was superseded")
            if (!fallbackSafe || !(options.unavailable ?? isUnavailable)(error))
              throw error
            let saved: OfflineSnapshot | null
            try {
              saved = await cache.get(key)
            } catch {
              check()
              throw error
            }
            check()
            if (readEpoch !== cacheEpoch)
              throw new Error("Saved library request was superseded")
            if (!saved) throw error
            if (versions.get(key) === version)
              options.onOfflineRead?.({ key, cachedAt: saved.cachedAt })
            return structuredClone(saved.payload)
          }
          check()
          if (versions.get(key) === version) {
            const write = writes.then(async () => {
              if (
                current() &&
                versions.get(key) === version &&
                readEpoch === cacheEpoch
              )
                await cache.put(key, sanitizeOfflineData(result))
            })
            writes = write.catch(() => {})
            try {
              await write
            } catch {
              /* Browsing storage is optional. */
            }
            check()
            if (readEpoch === cacheEpoch) options.onOnlineRead?.(key)
          }
          return result
        } finally {
          if (versions.get(key) === version) versions.delete(key)
        }
      }
      methods.set(property, wrapped)
      return wrapped
    },
  })
  const checkFresh = () => {
    if (
      provider.isOffline ||
      provider.cacheScope !== initialScope ||
      provider.playbackSession !== initialSession ||
      !(options.owns?.() ?? true)
    )
      throw new Error(
        "Current playlist request was superseded. Reconnect and try again."
      )
  }
  freshReads.set(proxy, {
    getPlaylists: async (...args) => {
      checkFresh()
      const result = await provider.getPlaylists(...args)
      checkFresh()
      return result
    },
    getPlaylistItems: async (...args) => {
      checkFresh()
      const result = await provider.getPlaylistItems(...args)
      checkFresh()
      return result
    },
  })
  return proxy
}
