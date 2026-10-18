import { musicEntityHref, type MusicEntityRef } from "./musicEntity"
import { artistNameSimilarity, artistNameKey, ARTIST_NAME_THRESHOLD } from "./artistMatching"
import { releaseNameKey } from "./musicMatching"
import { artistCreditsKey } from "./artistCredits"
import { withTimeout } from "./withTimeout"

/** Resolve on navigation, never by scanning every visible playlist/queue row. */
export function createMusicLinkResolver({ searchPlex, searchYoutube, hydrate, indexed, knownPlex, current, now = Date.now, optionalWaitMs = 150, lookupTimeoutMs = 8_000 }: {
  searchPlex: (ref: MusicEntityRef) => Promise<{ id: string; name: string; artist?: string; year?: number | null }[]>
  searchYoutube: (ref: MusicEntityRef) => Promise<{ id: string; name: string; artist?: string; year?: number | null }[]>
  current: () => boolean
  hydrate?: (ref: MusicEntityRef) => Promise<MusicEntityRef | null>
  indexed?: (ref: MusicEntityRef) => Promise<{ handled: boolean; href: string | null; plexChecked?: boolean } | null>
  knownPlex?: (ref: MusicEntityRef) => Promise<boolean>
  now?: () => number
  optionalWaitMs?: number
  lookupTimeoutMs?: number
}) {
  const cache = new Map<string, { until: number; promise: Promise<string | null> }>()
  const knownRequests = new Map<string, Promise<string | null>>()
  const match = (ref: MusicEntityRef, item: { name: string; artist?: string; year?: number | null }) => ref.kind === "artist"
    ? artistNameSimilarity(ref.name, item.name) >= ARTIST_NAME_THRESHOLD
    : releaseNameKey(ref.name) === releaseNameKey(item.name) && !!ref.artist && !!item.artist &&
      artistNameSimilarity(artistCreditsKey(ref.artist), artistCreditsKey(item.artist)) >= ARTIST_NAME_THRESHOLD && (!ref.year || !item.year || ref.year === item.year)
  const candidates = (ref: MusicEntityRef, rows: { id: string; name: string; artist?: string; year?: number | null }[]) => {
    // A unique exact artist name beats a fuzzy neighbor. Multiple identities with
    // the same exact name still require disambiguation, never search position.
    const exact = ref.kind === "artist" ? rows.filter(row => artistNameKey(row.name) === artistNameKey(ref.name)) : []
    return [...new Map((exact.length ? exact : rows.filter(row => match(ref, row)))
      .map(row => [musicEntityHref(ref.kind, row.id), row])).values()]
  }
  return async (ref: MusicEntityRef): Promise<string | null> => {
    if (!current()) return null
    if (ref.id && !ref.id.startsWith("ytmusic:")) {
      const present = !knownPlex || await withTimeout(knownPlex(ref), optionalWaitMs, "Plex identity check timed out.").catch(() => true)
      if (!current()) return null
      if (present) return musicEntityHref(ref.kind, ref.id)
      ref = { ...ref, id: null }
    }
    if (ref.kind === "album" && (!ref.id || !ref.name) && ref.trackId && hydrate) {
      ref = await withTimeout(hydrate(ref), lookupTimeoutMs, "Album lookup timed out. Please try again.") ?? ref
      if (!current()) return null
    }
    const known = musicEntityHref(ref.kind, ref.id)
    if (ref.id && !ref.id.startsWith("ytmusic:")) return known
    if (!ref.name) return known
    let plexFailed = false
    const plex = async () => {
      if (indexed) {
        const proof = await indexed(ref)
        if (!current()) return null
        if (proof?.handled || proof?.plexChecked) return proof.href
      }
      // A known YTM identity does not need a live Plex search before opening.
      if (known && indexed) return null
      const rows = candidates(ref, await searchPlex(ref))
      return current() && rows.length === 1 ? musicEntityHref(ref.kind, rows[0].id) : null
    }
    // Recheck verified local mappings on each known-ID click, with a small
    // budget. The artist page enriches itself after its YTM catalog is visible.
    if (known) {
      const key = JSON.stringify(ref)
      let lookup = knownRequests.get(key)
      if (!lookup) {
        lookup = withTimeout(plex(), optionalWaitMs, "Plex lookup timed out.").catch(() => null)
        knownRequests.set(key, lookup)
        void lookup.finally(() => { if (knownRequests.get(key) === lookup) knownRequests.delete(key) })
      }
      const mapped = await lookup
      return current() ? mapped ?? known : null
    }
    const key = JSON.stringify([ref.kind, ref.id, ref.name, ref.artist, ref.year, ref.trackId])
    const saved = cache.get(key)
    if (saved && saved.until > now()) return saved.promise
    const promise = (async () => {
      // Start both services together. Optional Plex work cannot hold YTM fallback.
      const local = withTimeout(plex(), optionalWaitMs, "Plex lookup timed out.").catch(() => { plexFailed = true; return null })
      const remote = withTimeout(searchYoutube(ref), lookupTimeoutMs, "YouTube Music lookup timed out. Please try again.")
        .then(rows => ({ rows }), error => ({ error }))
      const mapped = await local
      if (!current()) return null
      if (mapped) return mapped
      const result = await remote
      if (!current()) return null
      if ("error" in result) throw result.error
      const rows = candidates(ref, result.rows)
      if (rows.length > 1) throw Error(`Several ${ref.kind === "artist" ? "artists" : "albums"} match “${ref.name}”. Open Search to choose the right one.`)
      return rows.length === 1 ? musicEntityHref(ref.kind, rows[0].id) : null
    })()
    cache.set(key, { until: now() + 10 * 60_000, promise })
    if (cache.size > 256) cache.delete(cache.keys().next().value!)
    try {
      const href = await promise
      if (!href && cache.get(key)?.promise === promise) {
        if (plexFailed || !current()) cache.delete(key)
        else cache.set(key, { until: now() + 60_000, promise })
      }
      return href
    } catch (error) {
      if (cache.get(key)?.promise === promise) cache.delete(key)
      throw error
    }
  }
}
