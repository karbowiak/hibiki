import { musicEntityHref, type MusicEntityRef } from "./musicEntity"
import { artistNameSimilarity, ARTIST_NAME_THRESHOLD } from "./artistMatching"
import { releaseNameKey } from "./musicMatching"

/** Resolve on navigation, never by scanning every visible playlist/queue row. */
export function createMusicLinkResolver({ searchPlex, searchYoutube, current, now = Date.now }: {
  searchPlex: (ref: MusicEntityRef) => Promise<{ id: string; name: string; artist?: string; year?: number | null }[]>
  searchYoutube: (ref: MusicEntityRef) => Promise<{ id: string; name: string; artist?: string; year?: number | null }[]>
  current: () => boolean
  now?: () => number
}) {
  const cache = new Map<string, { until: number; promise: Promise<string | null> }>()
  const match = (ref: MusicEntityRef, item: { name: string; artist?: string; year?: number | null }) => ref.kind === "artist"
    ? artistNameSimilarity(ref.name, item.name) >= ARTIST_NAME_THRESHOLD
    : releaseNameKey(ref.name) === releaseNameKey(item.name) && !!ref.artist && !!item.artist &&
      artistNameSimilarity(ref.artist, item.artist) >= ARTIST_NAME_THRESHOLD && (!ref.year || !item.year || ref.year === item.year)
  return async (ref: MusicEntityRef): Promise<string | null> => {
    if (!current()) return null
    const known = musicEntityHref(ref.kind, ref.id)
    if (ref.id && !ref.id.startsWith("ytmusic:")) return known
    const key = JSON.stringify([ref.kind, ref.id, ref.name, ref.artist, ref.year])
    const saved = cache.get(key)
    if (saved && saved.until > now()) return saved.promise
    const promise = (async () => {
      try {
        const candidates = [...new Map((await searchPlex(ref)).filter(item => match(ref, item)).map(item => [item.id, item])).values()]
        if (!current()) return null
        // Ambiguous editions/names keep their known YTM destination instead of guessing.
        if (candidates.length === 1) return musicEntityHref(ref.kind, candidates[0].id)
      } catch { if (!current()) return null }
      if (known) return known
      const candidates = [...new Map((await searchYoutube(ref)).filter(item => match(ref, item)).map(item => [item.id, item])).values()]
      if (!current()) return null
      return candidates.length === 1 ? musicEntityHref(ref.kind, candidates[0].id) : null
    })()
    cache.set(key, { until: now() + 10 * 60_000, promise })
    if (cache.size > 256) cache.delete(cache.keys().next().value!)
    try {
      const href = await promise
      if (!href && cache.get(key)?.promise === promise) cache.set(key, { until: now() + 60_000, promise })
      return href
    } catch (error) {
      if (cache.get(key)?.promise === promise) cache.delete(key)
      throw error
    }
  }
}
