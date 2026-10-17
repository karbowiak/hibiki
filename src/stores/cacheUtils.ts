const DEFAULT_EVICTION_TTL_MS = 14 * 24 * 60 * 60_000 // 14 days

/** Prune entries older than the given TTL. Returns the same object if nothing was evicted. */
export function evictStaleEntries<T>(
  record: Record<string, { data: T; cachedAt: number }>,
  ttlMs: number = DEFAULT_EVICTION_TTL_MS,
  maxEntries = Infinity,
  keep?: string
): Record<string, { data: T; cachedAt: number }> {
  const now = Date.now(),
    cutoff = now - ttlMs
  const entries = Object.entries(record)
  let fresh = entries.filter(
    ([, v]) => v.cachedAt >= cutoff && v.cachedAt <= now
  )
  if (fresh.length > maxEntries)
    fresh = fresh
      .sort(
        (a, b) =>
          Number(b[0] === keep) - Number(a[0] === keep) ||
          b[1].cachedAt - a[1].cachedAt
      )
      .slice(0, maxEntries)
  if (fresh.length === entries.length) return record // nothing to evict
  return Object.fromEntries(fresh)
}

/** Evict oldest entries from a Map when it exceeds `max` size. */
export function evictMap<K, V>(map: Map<K, V>, max: number) {
  if (map.size <= max) return
  const toDelete = map.size - Math.floor(max * 0.75)
  let i = 0
  for (const key of map.keys()) {
    if (i++ >= toDelete) break
    map.delete(key)
  }
}
