import type { YoutubeMusicBrowsePage } from "../backends/ytmusic/discovery"
import type { ArtistCacheEntry } from "../stores/metadataCacheCore"

export const ARTIST_NAME_THRESHOLD = 0.93
export const artistNameKey = (name: string) => name.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
  .replace(/[^\p{L}\p{N}]+/gu, "")

/** Normalized edit similarity; short names require the same folded spelling. */
export function artistNameSimilarity(left: string, right: string): number {
  const a = Array.from(artistNameKey(left)), b = Array.from(artistNameKey(right))
  if (!a.length || !b.length) return 0
  if (a.join("") === b.join("")) return 1
  if (Math.max(a.length, b.length) > 256) return 0
  if (Math.min(a.length, b.length) < 6) return 0
  let row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return 1 - row[b.length] / Math.max(a.length, b.length)
}

interface CatalogItem { title: string; year?: number | null; duration?: number | null }
export interface ArtistCatalogEvidence { songs: CatalogItem[]; releases: CatalogItem[] }
const titleKey = (title: string) => title.normalize("NFKC").trim().toLowerCase()
  .replace(/[‘’]/g, "'").replace(/\s+/g, " ")
const releaseKey = (title: string) => titleKey(title).replace(/\s+-\s+(single|ep)$/, "")

export const plexArtistEvidence = (entry: Pick<ArtistCacheEntry, "albums" | "singles" | "popularTracks">): ArtistCatalogEvidence => ({
  songs: entry.popularTracks,
  releases: [...entry.albums, ...entry.singles],
})
export function youtubeArtistEvidence(page: YoutubeMusicBrowsePage): ArtistCatalogEvidence {
  return {
    songs: page.items.filter(item => item.kind === "song").map(item => {
      const parts = item.duration?.split(":").map(Number)
      const duration = parts?.length && parts.every(part => Number.isFinite(part) && part >= 0)
        ? parts.reduce((seconds, part) => seconds * 60 + part, 0) * 1000 : null
      return { title: item.title, duration }
    }),
    releases: page.hubs.filter(hub => ["albums", "singles"].includes(hub.category))
      .flatMap(hub => hub.items.filter(item => item.kind === "album").map(item => ({ title: item.title, year: item.year }))),
  }
}

/** Count distinct shared releases/recordings, retaining remix/live qualifiers. */
export function artistCatalogScore(reference: ArtistCatalogEvidence, candidate: ArtistCatalogEvidence): number {
  const songs = new Set(candidate.songs.filter(item => reference.songs.some(known => titleKey(known.title) === titleKey(item.title) &&
    (!known.duration || !item.duration || Math.abs(known.duration - item.duration) <= 5000))).map(item => titleKey(item.title)))
  const releases = new Set(candidate.releases.filter(item => reference.releases.some(known => releaseKey(known.title) === releaseKey(item.title) &&
    (!known.year || !item.year || known.year === item.year))).map(item => releaseKey(item.title)))
  return songs.size * 2 + releases.size * 3
}

export interface ArtistMatchCandidate<T> {
  value: T
  name: string
  catalog: ArtistCatalogEvidence
  canonicalId?: string | null
}

/** Resolve close names using catalogs; unrelated ties never pick the first row. */
export function selectArtistCandidate<T>(name: string, reference: ArtistCatalogEvidence, candidates: ArtistMatchCandidate<T>[]): T | null {
  const ranked = candidates.map(candidate => ({ ...candidate, similarity: artistNameSimilarity(name, candidate.name),
    overlap: artistCatalogScore(reference, candidate.catalog) }))
    .filter(candidate => candidate.similarity >= ARTIST_NAME_THRESHOLD)
    .sort((a, b) => b.overlap - a.overlap || b.similarity - a.similarity)
  const best = ranked[0]
  if (!best) return null
  if (ranked.length === 1) return best.value
  const tied = ranked.filter(candidate => candidate.overlap === best.overlap)
  if (best.overlap > 0 && tied.length === 1) return best.value
  // Different browse IDs can be aliases of the same official subscription
  // channel. Prefer its fuller music catalog rather than its search position.
  if (best.canonicalId && tied.every(candidate => candidate.canonicalId === best.canonicalId))
    return [...tied].sort((a, b) => (b.catalog.songs.length + b.catalog.releases.length) -
      (a.catalog.songs.length + a.catalog.releases.length))[0].value
  if (best.similarity - ranked[1].similarity >= 0.02 && (best.overlap > 0 || artistNameKey(name) === artistNameKey(best.name))) return best.value
  return null
}
