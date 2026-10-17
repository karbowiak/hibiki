import { evictStaleEntries } from "../../stores/cacheUtils"
import type { PodcastDetail, PodcastTopChart } from "./api"

export interface PodcastCaches {
  feedCache: Record<string, { data: PodcastDetail; cachedAt: number }>
  topChartCache: Record<string, { data: PodcastTopChart[]; cachedAt: number }>
}
/** Disposable RSS/chart snapshots never share progress writes or grow forever. */
export function boundPodcastCaches(
  value: Partial<PodcastCaches>
): PodcastCaches {
  const feeds = Object.fromEntries(
    Object.entries(value.feedCache ?? {}).filter(
      ([, entry]) => entry?.data && Array.isArray(entry.data.episodes)
    )
  )
  const charts = Object.fromEntries(
    Object.entries(value.topChartCache ?? {}).filter(([, entry]) =>
      Array.isArray(entry?.data)
    )
  )
  const result = {
    feedCache: evictStaleEntries(feeds, 7 * 86400_000, 32),
    topChartCache: evictStaleEntries(charts, 86400_000, 16),
  }
  let remaining = 16 * 1024 * 1024
  const entries = [
    ...Object.entries(result.feedCache).map(([key, value]) => ({
      key,
      value,
      kind: "feedCache" as const,
    })),
    ...Object.entries(result.topChartCache).map(([key, value]) => ({
      key,
      value,
      kind: "topChartCache" as const,
    })),
  ].sort((a, b) => b.value.cachedAt - a.value.cachedAt)
  for (const entry of entries) {
    const bytes = new TextEncoder().encode(JSON.stringify(entry.value)).length
    if (bytes > remaining) delete result[entry.kind][entry.key]
    else remaining -= bytes
  }
  return result
}
