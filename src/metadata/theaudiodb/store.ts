import { create } from "zustand"
import { isTauri } from "@tauri-apps/api/core"
import { useProviderStore } from "../../stores/providerStore"
import { theAudioDbStatus, theAudioDbConfigure, theAudioDbLookup } from "./api"
import type { TheAudioDbResult } from "./api"
import type { MetadataIdentity } from "../core/types"
import type { MetadataServiceStatus } from "../services/api"
const TTL = 6 * 60 * 60 * 1000
interface State {
  cacheVersion: number
  status: MetadataServiceStatus | null
  loading: boolean
  error: string | null
  load(): Promise<void>
  configure(args: {
    apiKey?: string
    enabled: boolean
    clear?: boolean
  }): Promise<boolean>
}
export function createTheAudioDbStore(
  api = {
    status: theAudioDbStatus,
    configure: theAudioDbConfigure,
    lookup: theAudioDbLookup,
  },
  desktop = isTauri
) {
  let generation = 0,
    loading: Promise<void> | null = null
  const cache = new Map<
    string,
    { expires: number; result: TheAudioDbResult; revision: string }
  >()
  const pending = new Map<string, Promise<TheAudioDbResult>>()
  const itemVersions = new Map<string, object>()
  let providerEpoch = 0
  useProviderStore.subscribe((next, old) => {
    if (
      next.provider !== old.provider ||
      next.provider?.cacheScope !== old.provider?.cacheScope
    ) {
      providerEpoch++
      pending.clear()
    }
  })
  const store = create<State>((set, get) => ({
    cacheVersion: 0,
    status: null,
    loading: false,
    error: null,
    load() {
      if (!desktop()) return Promise.resolve()
      if (loading) return loading
      const owner = ++generation
      set({ loading: true, error: null })
      const request = api
        .status()
        .then(
          (status) => {
            if (owner !== generation) return
            if (get().status?.revision !== status.revision) {
              cache.clear()
              pending.clear()
            }
            set({ status, loading: false })
          },
          () => {
            if (owner === generation)
              set({
                loading: false,
                error: "Could not read TheAudioDB settings. Retry.",
              })
          }
        )
        .finally(() => {
          if (loading === request) loading = null
        })
      loading = request
      return request
    },
    async configure(args) {
      const status = get().status
      if (!status || get().loading || !desktop()) return false
      const owner = ++generation
      cache.clear()
      pending.clear()
      set({ status: null, loading: true, error: null })
      try {
        const next = await api.configure({
          revision: status.revision,
          apiKey: args.apiKey || null,
          enabled: args.enabled,
          clear: args.clear ?? false,
        })
        if (owner !== generation) return false
        set({ status: next, loading: false })
        return true
      } catch {
        if (owner === generation)
          set({
            loading: false,
            error:
              "TheAudioDB settings could not be confirmed. Reload settings before retrying.",
          })
        return false
      }
    },
  }))
  const keyFor = (identity: MetadataIdentity, mbid?: string) =>
    JSON.stringify([
      identity.scope,
      identity.kind,
      identity.artist,
      identity.title,
      mbid,
    ])
  const itemKeyFor = (identity: MetadataIdentity) =>
    JSON.stringify([
      identity.scope,
      identity.kind,
      identity.artist,
      identity.title,
    ])
  return {
    store,
    peek(
      identity: MetadataIdentity,
      mbid?: string
    ): TheAudioDbResult | undefined {
      const entry = cache.get(keyFor(identity, mbid))
      const status = store.getState().status
      return entry &&
        entry.expires > Date.now() &&
        status?.enabled &&
        status.configured &&
        entry.revision === status.revision &&
        (entry.result.status !== "ready" ||
          entry.result.item.revision === status.revision)
        ? entry.result
        : undefined
    },
    invalidate(identity: MetadataIdentity) {
      const itemKey = itemKeyFor(identity)
      itemVersions.set(itemKey, {})
      for (const key of pending.keys())
        if (JSON.stringify(JSON.parse(key).slice(0, 4)) === itemKey)
          pending.delete(key)
      for (const key of cache.keys()) {
        const [scope, kind, artist, title] = JSON.parse(key)
        if (
          scope === identity.scope &&
          kind === identity.kind &&
          artist === identity.artist &&
          title === identity.title
        )
          cache.delete(key)
      }
      store.setState((state) => ({ cacheVersion: state.cacheVersion + 1 }))
      if (itemVersions.size > 128)
        for (const key of itemVersions.keys()) {
          if (
            key !== itemKey &&
            ![...pending.keys()].some(
              (p) => JSON.stringify(JSON.parse(p).slice(0, 4)) === key
            )
          ) {
            itemVersions.delete(key)
            break
          }
        }
    },
    async lookup(
      identity: MetadataIdentity,
      mbid?: string
    ): Promise<TheAudioDbResult> {
      const status = store.getState().status
      if (!desktop() || !status?.configured || !status.enabled)
        return { status: "unavailable" }
      const key = keyFor(identity, mbid),
        saved = cache.get(key)
      if (
        saved &&
        saved.expires > Date.now() &&
        saved.revision === status.revision &&
        (saved.result.status !== "ready" ||
          saved.result.item.revision === status.revision)
      )
        return saved.result
      if (pending.has(key)) return pending.get(key)!
      if (pending.size >= 16) throw new Error("TheAudioDB lookup queue is full")
      const owner = generation
      const capturedProviderEpoch = providerEpoch
      const itemKey = itemKeyFor(identity)
      if (!itemVersions.has(itemKey)) itemVersions.set(itemKey, {})
      const itemVersion = itemVersions.get(itemKey)
      if (itemVersions.size > 128)
        itemVersions.delete(itemVersions.keys().next().value!)
      const request = api
        .lookup(status.revision, identity, mbid)
        .then((result) => {
          if (
            owner !== generation ||
            providerEpoch !== capturedProviderEpoch ||
            itemVersions.get(itemKeyFor(identity)) !== itemVersion ||
            store.getState().status?.revision !== status.revision
          )
            return { status: "unavailable" } as const
          if (
            result.status === "ready" &&
            (result.item.revision !== status.revision ||
              result.item.kind !== identity.kind ||
              result.item.artist.trim().toLowerCase() !==
                identity.artist.trim().toLowerCase() ||
              (identity.kind !== "artist" &&
                result.item.title?.trim().toLowerCase() !==
                  identity.title?.trim().toLowerCase()) ||
              (mbid && result.item.mbid?.toLowerCase() !== mbid.toLowerCase()))
          )
            return { status: "unavailable" } as const
          cache.delete(key)
          cache.set(key, {
            expires: Date.now() + (result.status === "ready" ? TTL : 60_000),
            revision: status.revision,
            result,
          })
          if (cache.size > 64) cache.delete(cache.keys().next().value!)
          store.setState((state) => ({ cacheVersion: state.cacheVersion + 1 }))
          return result
        })
        .finally(() => {
          if (pending.get(key) === request) pending.delete(key)
        })
      pending.set(key, request)
      return request
    },
  }
}
export const theAudioDb = createTheAudioDbStore()
export const useTheAudioDbStore = theAudioDb.store
