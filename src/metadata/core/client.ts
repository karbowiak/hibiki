import { metadataIdentityKey } from "./resolve"
import type { MetadataAdapter, MetadataIdentity, MetadataResult } from "./types"
export interface MetadataOwner {
  scope: string
  token: unknown
}
/** Bounded in-memory snapshots for one active library/account lease. Existing
 * adapters own disk caches and native rate limits; this never persists URLs. */
export function createMetadataClient(
  adapters: readonly MetadataAdapter[],
  getOwner: () => MetadataOwner | null,
  options: {
    maxPending?: number
    maxEntries?: number
    ttlMs?: number
    now?: () => number
  } = {}
) {
  const maxPending = Math.max(1, Math.min(options.maxPending ?? 32, 64))
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? 128, 512))
  const ttlMs = options.ttlMs ?? 60_000,
    now = options.now ?? Date.now
  let epoch = 0
  const pending = new Map<string, Promise<MetadataResult>>()
  const cache = new Map<string, { result: MetadataResult; expires: number }>()
  const tails = new Map<string, Promise<unknown>>()
  let activeOwner: MetadataOwner | null = null
  const sameOwner = (a: MetadataOwner | null, b: MetadataOwner | null) =>
    !!a && !!b && a.scope === b.scope && a.token === b.token
  const retire = () => {
    epoch++
    pending.clear()
    cache.clear()
    tails.clear()
    activeOwner = null
  }
  function lookup(
    source: MetadataAdapter["id"],
    request: MetadataIdentity
  ): Promise<MetadataResult> {
    const owner = getOwner()
    if (!sameOwner(owner, activeOwner)) {
      retire()
      activeOwner = owner ? { ...owner } : null
    }
    if (!owner || request.scope !== owner.scope)
      return Promise.resolve({ status: "retired" })
    if (
      !request.artist.trim() ||
      (request.kind !== "artist" && !request.title?.trim())
    )
      return Promise.resolve({ status: "unavailable" })
    const adapter = adapters.find((item) => item.id === source)
    if (!adapter?.fields[request.kind]?.length)
      return Promise.resolve({ status: "unsupported" })
    const identity = { ...request },
      captured = { ...owner },
      generation = epoch
    const current = () =>
      generation === epoch && sameOwner(captured, getOwner())
    const key = JSON.stringify([
      source,
      request.scope,
      metadataIdentityKey(request),
    ])
    const saved = cache.get(key)
    if (saved && saved.expires > now()) return Promise.resolve(saved.result)
    if (saved) cache.delete(key)
    const existing = pending.get(key)
    if (existing) return existing
    if (pending.size >= maxPending)
      return Promise.resolve({
        status: "error",
        code: "queue-full",
        retryable: true,
      })
    // Serialize each source, while allowing different sources to progress independently.
    const previous = tails.get(source) ?? Promise.resolve()
    const job: Promise<MetadataResult> = previous
      .catch(() => {})
      .then(async () => {
        if (!current()) return { status: "retired" } as const
        try {
          const result = await adapter.lookup(identity)
          if (!current()) return { status: "retired" } as const
          if (result.status === "ready") {
            // An adapter cannot publish results belonging to a different request.
            if (
              result.snapshot.source !== source ||
              result.snapshot.identity.scope !== identity.scope ||
              metadataIdentityKey(result.snapshot.identity) !==
                metadataIdentityKey(identity)
            )
              return { status: "unavailable" } as const
            cache.set(key, { result, expires: now() + ttlMs })
            while (cache.size > maxEntries)
              cache.delete(cache.keys().next().value!)
          }
          return result
        } catch {
          return current()
            ? ({
                status: "error",
                code: "lookup-failed",
                retryable: true,
              } as const)
            : ({ status: "retired" } as const)
        }
      })
      .finally(() => {
        if (pending.get(key) === job) pending.delete(key)
        if (tails.get(source) === job) tails.delete(source)
      })
    pending.set(key, job)
    tails.set(source, job)
    return job
  }
  function invalidate(
    source: MetadataAdapter["id"],
    identity: MetadataIdentity
  ): boolean {
    if (identity.scope !== getOwner()?.scope) return false
    const adapter = adapters.find((item) => item.id === source)
    if (!adapter?.invalidate) return false
    // Retire pending publication before targeted invalidation; never flush every
    // provider's durable cache as a substitute for one item refresh.
    retire()
    adapter.invalidate(identity)
    return true
  }
  return {
    lookup,
    invalidate,
    retire,
    stats: () => ({ pending: pending.size, cached: cache.size }),
  }
}
