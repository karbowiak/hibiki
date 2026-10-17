import { invoke } from "@tauri-apps/api/core"
import type { MusicProvider } from "../providers/types"
import type { MusicItem, MusicTrack, PagedResult } from "../types/music"
import type {
  PlexRequestContext,
  PlexTransport,
} from "../backends/plex/scopedApi"
import { sanitizeOfflineData, forwardFreshPlaylistReads } from "./providerCache"
import { shuffled } from "../lib/pagedPlayback"
import type { CollectionOrder, PagedTrackSource } from "../lib/pagedPlayback"
import { projectOfflineAvailability } from "./catalogue"

const TTL = 15 * 60_000
const MIX_STAMP = "content-seeded-mix-v1"
interface Info {
  total: number
  cachedAt: number
  complete: boolean
  dirty: boolean
  stamp: string
  refreshing: boolean
}
interface Job {
  key: string
  stamp: string
  load: (offset: number, limit: number) => Promise<PagedResult<MusicItem>>
  force: boolean
}

/** One background worker, atomic generations, indexed SQLite reads, bounded renderer pages. */
export function createCollectionCacheProvider(
  provider: MusicProvider,
  raw: MusicProvider,
  context: PlexRequestContext,
  transport: PlexTransport = invoke
): MusicProvider {
  let stopped = false,
    running = false
  let activeJob: Job | null = null
  let epoch = 0
  const sources = new Map<string, WeakRef<PagedTrackSource>>()
  const pendingPins = new Set<string>()
  function livePins() {
    for (const [pin, source] of sources) if (!source.deref()) sources.delete(pin)
    return [...sources.keys(), ...pendingPins]
  }
  let timer: ReturnType<typeof setInterval> | undefined
  const jobs = new Map<string, Job>()
  const methods = new Map<PropertyKey, unknown>()
  const failures = new Set<string>()
  const preparing = new Map<string, Promise<void>>()
  const foreground = new Set<string>()
  const mixPaths = new Map<string, string>()
  async function resolveKey(key: string) {
    if (!key.startsWith("mix:/")) return key
    const path = key.slice(4)
    const digest = await crypto.subtle.digest(
      "SHA-256",
      // Old cache keys contain linear server order. Rebuild those snapshots
      // without confusing a partially staged upgrade with an active mixed one.
      new TextEncoder().encode(`${MIX_STAMP}\0${path}`)
    )
    const resolved =
      "mix:" +
      [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
    mixPaths.set(resolved, path)
    return resolved
  }
  const session = provider.playbackSession
  const owns = () =>
    !stopped &&
    provider.playbackSession === session &&
    provider.cacheScope === context.cacheScope
  const online = () => owns() && !provider.isOffline && raw.isConnected()
  const project = async <T>(value: T): Promise<T> =>
    provider.isOffline
      ? ((await projectOfflineAvailability(context, value)) as T)
      : value
  const call = async <T>(
    op: string,
    key: string,
    args: Record<string, unknown> = {}
  ): Promise<T> => {
    if (!owns()) throw Error("Collection request was superseded")
    const version = epoch
    const value = await transport<T>("collection_cache", {
      context,
      request: { op, key, ...args },
    })
    if (!owns() || version !== epoch) throw Error("Collection request was superseded")
    return value
  }
  const notify = (key: string) => {
    if (typeof window !== "undefined")
      window.dispatchEvent(
        new CustomEvent("collection-cache-updated", { detail: key })
      )
  }
  const enqueue = (job: Job) => {
    failures.delete(job.key)
    jobs.set(job.key, job)
    void pump()
  }
  async function pump() {
    if (running || !online()) return
    running = true
    try {
      while (jobs.size && online()) {
        const job =
          [...jobs.values()].find((job) => foreground.has(job.key)) ??
          jobs.values().next().value!
        jobs.delete(job.key)
        activeJob = job
        const version = epoch
        try {
          const info = await call<Info | null>("info", job.key)
          if (
            !job.force &&
            info?.complete &&
            !info.dirty &&
            !info.refreshing &&
            info.stamp === job.stamp &&
            Date.now() - info.cachedAt < TTL
          )
            continue
          const token = await call<{ generation: number; offset: number }>(
            "begin",
            job.key,
            { stamp: job.stamp }
          )
          let offset = token.offset,
            done = false
          // Yield large collections to the remaining queue after four bounded pages.
          for (let page = 0; page < 4 && online(); page++) {
            const result = await job.load(offset, 500)
            if (!online() || version !== epoch) break
            if (result.offset !== undefined && result.offset !== offset)
              throw Error("Collection paging did not advance")
            const total = result.total || offset + result.items.length
            if (
              result.items.length > 500 ||
              (!result.items.length && offset < total)
            )
              throw Error("Collection changed while caching")
            await call("put", job.key, {
              generation: token.generation,
              offset,
              total,
              items: sanitizeOfflineData(result.items),
            })
            offset += result.items.length
            if (offset >= total) {
              const result = await call<{ changed: boolean }>(
                "commit",
                job.key,
                { generation: token.generation }
              )
              if (result.changed) {
                notify(job.key)
                if (mixPaths.has(job.key))
                  notify(`mix:${mixPaths.get(job.key)}`)
              }
              done = true
              break
            }
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          if (!done && online() && version === epoch && !jobs.has(job.key))
            jobs.set(job.key, { ...job, force: true })
        } catch (error) {
          if (version !== epoch) continue
          failures.add(job.key)
          if (
            /Collection changed|membership page|did not advance/i.test(
              String(error)
            )
          )
            await call("invalidate", job.key).catch(() => {})
          // Keep the previous complete snapshot. No tight retry loop or persistent warning.
          // The next scheduled pass resumes valid checkpoints or replaces invalidated ones.
        } finally {
          activeJob = null
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } finally {
      running = false
      if (jobs.size && online()) void pump()
    }
  }
  let rosterRequest: ReturnType<MusicProvider["getPlaylists"]> | undefined
  function roster() {
    if (!rosterRequest) {
      const request = raw.getPlaylists().finally(() => {
        if (rosterRequest === request) rosterRequest = undefined
      })
      rosterRequest = request
    }
    return rosterRequest
  }
  async function schedule(keys?: readonly string[]) {
    if (!online()) return
    const version = epoch
    for (const kind of ["track", "album", "artist"] as const) {
      if (!raw.getRatedItemsPage || (keys && !keys.includes(`rated:${kind}`)))
        continue
      enqueue({
        key: `rated:${kind}`,
        stamp: `rated:${kind}`,
        force: false,
        load: (offset, limit) => raw.getRatedItemsPage!(kind, offset, limit),
      })
    }
    if (
      keys &&
      !keys.some((key) => key === "playlists" || key.startsWith("playlist:"))
    )
      return
    try {
      const playlists = await roster()
      if (!online() || version !== epoch) return
      if (!keys || keys.includes("playlists")) {
        await call("maintain", "playlists", { pins: livePins(), playlists: playlists.map(playlist => playlist.id) })
        if (!online() || version !== epoch) return
        const present = new Set(playlists.map(playlist => `playlist:${playlist.id}`))
        for (const key of jobs.keys()) if (key.startsWith("playlist:") && !present.has(key)) jobs.delete(key)
      }
      if (!keys || keys.includes("playlists")) {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify(sanitizeOfflineData(playlists))
          )
        )
        if (!online() || version !== epoch) return
        enqueue({
          key: "playlists",
          stamp: [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
          force: false,
          load: async (offset, limit) => ({
            items: playlists
              .slice(offset, offset + limit)
              .map((item) => ({ ...item, type: "playlist" as const })),
            total: playlists.length,
            offset,
          }),
        })
      }
      for (const playlist of [...playlists].sort(
        (a, b) => a.trackCount - b.trackCount
      )) {
        if (keys && !keys.includes(`playlist:${playlist.id}`)) continue
        enqueue({
          key: `playlist:${playlist.id}`,
          stamp: JSON.stringify([
            playlist.trackCount,
            playlist.duration,
            (playlist._providerData as { updated_at?: number } | undefined)
              ?.updated_at,
          ]),
          force: false,
          load: async (offset, limit) => {
            const page = await raw.getPlaylistItems(playlist.id, offset, limit)
            return {
              ...page,
              items: page.items.map((item) => ({
                ...item,
                type: "track" as const,
              })),
            }
          },
        })
      }
    } catch {
      /* A disconnected server is retried by the next pass. */
    }
  }
  const warm = () => {
    if (stopped) return
    void schedule()
    if (!timer)
      timer = setInterval(() => {
        if (!owns()) {
          clearInterval(timer)
          timer = undefined
        } else void schedule()
      }, TTL)
  }
  const stop = () => {
    stopped = true
    jobs.clear()
    clearInterval(timer)
    timer = undefined
  }
  function ensure(key: string): Promise<void> {
    const existing = preparing.get(key)
    if (existing) return existing
    foreground.add(key)
    const pending = prepare(key).finally(() => {
      if (preparing.get(key) === pending) {
        preparing.delete(key)
        foreground.delete(key)
      }
    })
    preparing.set(key, pending)
    return pending
  }
  async function prepare(key: string) {
    const version = epoch
    const info = await call<Info | null>("info", key)
    const current = (info: Info | null) =>
      info?.complete &&
      !info.dirty &&
      (!mixPaths.has(key) || info.stamp === MIX_STAMP)
    if (current(info)) return
    if (!online())
      throw Error("Reconnect to Plex to prepare this collection for searching.")
    let job: Job
    if (key.startsWith("rated:") && raw.getRatedItemsPage) {
      const kind = key.slice(6) as "track" | "album" | "artist"
      job = {
        key,
        stamp: key,
        force: true,
        load: (offset, limit) => raw.getRatedItemsPage!(kind, offset, limit),
      }
    } else if (key.startsWith("playlist:")) {
      const id = key.slice(9)
      const playlist = (await raw.getPlaylists()).find((item) => item.id === id)
      if (version !== epoch) throw Error("Collection request was superseded")
      if (!playlist) throw Error("This playlist is no longer available.")
      job = {
        key,
        stamp: JSON.stringify([
          playlist.trackCount,
          playlist.duration,
          (playlist._providerData as { updated_at?: string } | undefined)
            ?.updated_at,
        ]),
        force: true,
        load: async (offset, limit) => {
          const page = await raw.getPlaylistItems(id, offset, limit)
          return {
            ...page,
            items: page.items.map((item) => ({
              ...item,
              type: "track" as const,
            })),
          }
        },
      }
    } else if (mixPaths.has(key) && raw.getMixTracksPage) {
      job = {
        key,
        stamp: MIX_STAMP,
        force: true,
        load: async (offset, limit) => {
          const page = await raw.getMixTracksPage!(
            mixPaths.get(key)!,
            offset,
            limit
          )
          return {
            ...page,
            items: page.items.map((item) => ({
              ...item,
              type: "track" as const,
            })),
          }
        },
      }
    } else throw Error("This collection cannot be searched.")
    if (activeJob?.key !== key) {
      const waiting = [...jobs.entries()].filter(
        ([existing]) => existing !== key
      )
      jobs.clear()
      enqueue(job)
      waiting.forEach(([key, value]) => jobs.set(key, value))
    }
    const start = Date.now()
    while (online() && version === epoch && Date.now() - start < 120_000) {
      const ready = await call<Info | null>("info", key)
      if (current(ready)) return
      if (failures.has(key)) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw Error("This collection is still being prepared. Try again shortly.")
  }
  async function invalidate(keys: string[]) {
    for (const key of keys) {
      await call("invalidate", key)
      notify(key)
    }
    void schedule(keys)
  }
  const proxy = new Proxy(provider, {
    get(target, property) {
      if (property === "savedQueue")
        return {
          load: () =>
            transport("saved_queue", { context, request: { op: "load" } }),
          save: (snapshot: unknown) =>
            transport("saved_queue", {
              context,
              request: { op: "save", ...(snapshot as object) },
            }),
          position: (state: unknown) =>
            transport("saved_queue", {
              context,
              request: { op: "position", state },
            }),
          clear: () =>
            transport("saved_queue", { context, request: { op: "clear" } }),
        }
      if (property === "warmCollections") return warm
      if (property === "stopCollectionWarmup") return stop
      if (property === "getLibraryCacheInfo") return () => call("stats", "playlists")
      if (property === "clearLibraryCache") return async () => {
        epoch++
        jobs.clear()
        failures.clear()
        preparing.clear()
        foreground.clear()
        rosterRequest = undefined
        await call("maintain", "playlists", { pins: livePins(), playlists: null })
        if (provider.clearLibraryCache) await provider.clearLibraryCache()
        else await transport("offline_cache_clear", { context })
        if (!owns()) throw Error("Collection request was superseded")
        notify("*")
      }
      if (methods.has(property)) return methods.get(property)
      const value = Reflect.get(target, property, target)
      if (property === "favorites" && value) {
        if (methods.has(property)) return methods.get(property)
        const native = value as NonNullable<MusicProvider["favorites"]>
        const favorites = {
          ...native,
          cachedTracks: async (ids: string[]) => {
            const rows = await call<(MusicTrack | null)[]>(
              "items",
              "rated:track",
              { ids }
            ).catch(() => ids.map(() => null))
            const missing = ids.filter((_id, index) => !rows[index])
            const fallback = missing.length
              ? ((await native.cachedTracks?.(missing)) ?? [])
              : []
            return project([
              ...rows.filter((row): row is MusicTrack => !!row),
              ...fallback,
            ])
          },
        }
        methods.set(property, favorites)
        return favorites
      }
      let method: unknown
      if (property === "getCollectionPage")
        method = async (
          key: string,
          offset: number,
          limit: number,
          filter: string,
          sort: string,
          dir: string
        ) => {
          key = await resolveKey(key)
          if (mixPaths.has(key)) await ensure(key)
          const read = () =>
            call<PagedResult<MusicItem> | null>("query", key, {
              offset,
              limit,
              filter,
              sort,
              dir,
            })
          let page = await read()
          if (!page) {
            await ensure(key)
            page = await read()
          }
          if (!page) throw Error("Could not read this collection. Try again.")
          return project(page)
        }
      else if (property === "getCachedTrackSource")
        method = async (
          key: string,
          shuffle = false,
          query?: CollectionOrder
        ) => {
          key = await resolveKey(key)
          if (query || mixPaths.has(key)) await ensure(key)
          const pin = crypto.randomUUID()
          pendingPins.add(pin)
          let refs: [string, string | null][] | null
          try {
            refs = await call("capture", key, { pin, query: query ?? null })
          } catch (error) {
            pendingPins.delete(pin)
            throw error
          }
          pendingPins.delete(pin)
          if (!refs) return null
          const order = shuffle ? shuffled(refs) : refs
          const source: PagedTrackSource = {
            key,
            ...(query ? { restoreQuery: { key, ...query } } : {}),
            total: order.length,
            entries: order.map(([id, occurrence]) => ({
              id,
              ...(occurrence ? { playlistItemId: occurrence } : {}),
            })),
            async loadItems(positions: number[]) {
              const selected = positions.map((position) => order[position])
              const rows = await call<(MusicTrack | null)[]>("items", key, {
                ids: selected.map((ref) => ref[0]),
              })
              if (rows.some((row) => !row))
                throw Error(
                  "Some cached songs are unavailable. Refresh the collection and try again."
                )
              return project(
                rows.map((row, i) =>
                  selected[i][1]
                    ? { ...row!, playlistItemId: selected[i][1] }
                    : row!
                )
              )
            },
            async loadPage(offset: number, limit: number) {
              const selected = order.slice(offset, offset + limit)
              const rows = await call<(MusicTrack | null)[]>("items", key, {
                ids: selected.map((ref) => ref[0]),
              })
              if (rows.some((row) => !row))
                throw Error(
                  "Some cached songs are unavailable. Refresh the collection and try again."
                )
              return project({
                items: rows.map((row, i) =>
                  selected[i][1]
                    ? { ...row!, playlistItemId: selected[i][1] }
                    : row!
                ),
                total: order.length,
                offset,
              })
            },
          }
          sources.set(pin, new WeakRef(source))
          return source
        }
      else if (property === "getRatedIndexPage")
        method = async (kind: "track" | "album", offset: number, limit: number) => {
          const key = `rated:${kind}`
          await ensure(key)
          const page = await call<PagedResult<MusicItem> | null>("index", key, { offset, limit })
          if (!page) throw Error("Could not read this collection index. Try again.")
          return page
        }
      else if (property === "getCollectionItems")
        method = async (key: string, ids: string[]) => {
          const rows = await call<(MusicItem | null)[]>("items", key, { ids })
          if (rows.some(row => !row)) throw Error("Some collection items are unavailable. Refresh and try again.")
          return project(rows as MusicItem[])
        }
      else if (property === "getPlaylistItems")
        method = async (id: string, offset = 0, limit = 100) => {
          const page = await call<PagedResult<MusicTrack> | null>(
            "page",
            `playlist:${id}`,
            { offset, limit: Math.min(500, limit) }
          ).catch(() => null)
          return page
            ? project(page)
            : target.getPlaylistItems(id, offset, limit)
        }
      else if (property === "getPlaylists")
        method = async () => {
          const info = await call<Info | null>("info", "playlists").catch(
            () => null
          )
          if (!info?.complete || info.dirty) return target.getPlaylists()
          const items: MusicItem[] = []
          for (let offset = 0; offset < info.total; offset += 500) {
            const page = await call<PagedResult<MusicItem> | null>(
              "page",
              "playlists",
              { offset, limit: 500 }
            )
            if (!page) return target.getPlaylists()
            items.push(...page.items)
          }
          return items.filter((item) => item.type === "playlist")
        }
      else if (property === "getRatedItemsPage")
        method = async (
          kind: "track" | "album" | "artist",
          offset: number,
          limit: number
        ) => {
          const page = await call<PagedResult<MusicItem> | null>(
            "page",
            `rated:${kind}`,
            { offset, limit }
          ).catch(() => null)
          return page
            ? project(page)
            : target.getRatedItemsPage!(kind, offset, limit)
        }
      else if (property === "getMixTracksPage" && raw.getMixTracksPage)
        method = async (path: string, offset: number, limit: number) => {
          const key = await resolveKey(`mix:${path}`)
          // Never expose a linear cold page or an older, unshuffled snapshot.
          await ensure(key)
          const cached = await call<PagedResult<MusicTrack> | null>(
            "page",
            key,
            { offset, limit }
          ).catch(() => null)
          if (online())
            enqueue({
              key,
              stamp: MIX_STAMP,
              force: false,
              load: async (start, size) => {
                const page = await raw.getMixTracksPage!(path, start, size)
                return {
                  ...page,
                  items: page.items.map((item) => ({
                    ...item,
                    type: "track" as const,
                  })),
                }
              },
            })
          if (!cached) throw Error("Could not read this mix. Try again.")
          return project(cached)
        }
      else if (property === "disconnect")
        method = async () => {
          stop()
          await target.disconnect()
        }
      else if (
        typeof value === "function" &&
        [
          "addToPlaylist",
          "removeFromPlaylist",
          "movePlaylistItem",
          "editPlaylist",
          "deletePlaylist",
          "createPlaylist",
          "mutatePlaylistOccurrence",
          "describePlaylist",
          "rate",
          "editMetadata",
          "editAdvancedMetadata",
          "saveArtwork",
        ].includes(String(property))
      )
        method = async (...args: unknown[]) => {
          const keys =
            property === "rate" ||
            ["editMetadata", "editAdvancedMetadata", "saveArtwork"].includes(
              String(property)
            )
              ? ["rated:track", "rated:album", "rated:artist"]
              : [
                  "playlists",
                  ...(typeof args[0] === "string" &&
                  property !== "createPlaylist"
                    ? [`playlist:${args[0]}`]
                    : []),
                ]
          try {
            const result = await value.apply(target, args)
            if (
              property === "rate" &&
              typeof args[0] === "string" &&
              online()
            ) {
              await call("rate", "rated:track", {
                id: args[0],
                rating: args[1],
              }).catch(() => {})
              notify(`item:${args[0]}`)
            }
            return result
          } finally {
            if (online()) await invalidate(keys).catch(() => {})
          }
        }
      else if (typeof value === "function") method = value.bind(target)
      else return value
      methods.set(property, method)
      return method
    },
  })
  forwardFreshPlaylistReads(proxy, provider)
  return proxy
}
