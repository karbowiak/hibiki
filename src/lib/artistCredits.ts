import type { MusicArtistCredit, MusicAlbum, MusicTrack } from "../types/music"

// Ampersands, slashes and '+' belong to many real artist names. Split only
// explicit collaboration markers and list separators, outside quoted names.
// Known comma names stay whole when a provider supplies only display text.
const commaNames = new Set([
  "tyler, the creator", "earth, wind & fire", "crosby, stills & nash",
  "crosby, stills, nash & young", "peter, paul and mary", "peter, bjorn and john",
])
const key = (name: string) => name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")

export function splitArtistCredit(name: string): string[] {
  if (commaNames.has(key(name))) return [name.trim()]
  const parts: string[] = []
  // Quoted credits can contain commas. Leave apostrophes in names untouched.
  for (const segment of name.match(/"[^"]+"|[^";,]+|[;,]/g) ?? []) {
    if (/^[;,]$/.test(segment)) continue
    const quoted = segment.startsWith('"') && segment.endsWith('"')
    parts.push(...(quoted ? [segment.slice(1, -1)] : segment.split(/\s+(?:x|×|feat\.?|ft\.?|featuring|with)\s+/i)))
  }
  return parts.map(part => part.trim()).filter(Boolean)
}

/** Structured credits are authoritative, including punctuation in their names. */
export function normalizeArtistCredits(name: string, id?: string | null, structured?: readonly MusicArtistCredit[]): MusicArtistCredit[] {
  const names = splitArtistCredit(name)
  const candidates = structured?.length ? structured : names.map(name => ({ name, id: names.length === 1 ? id : null }))
  const found = new Map<string, MusicArtistCredit>()
  for (const credit of candidates) {
    const name = credit.name.trim(), identity = key(name)
    if (!identity) continue
    const previous = found.get(identity)
    if (!previous || (!previous.id && credit.id)) found.set(identity, { name, id: credit.id || null })
  }
  return [...found.values()]
}

/** A canonical Plex artist can legitimately contain a separator (Yeico X Toni).
 * Local-only combined artists carry no such evidence and need credit splitting. */
export function plexArtistCredits(name: string, id: string | null, guid?: string | null) {
  return normalizeArtistCredits(name, id, guid?.startsWith("plex://artist/") ? [{ name, id }] : undefined)
}

/** Also normalizes older cached entries at the point of use. */
export function itemArtistCredits(item: Pick<MusicTrack | MusicAlbum, "artistName" | "artistId" | "artistCredits"> & { originalTitle?: string | null; _providerData?: unknown }) {
  const name = item.originalTitle || item.artistName
  const provider = item._providerData as { grandparent_guid?: string; parent_guid?: string; youtubeMusic?: { artistId?: string; artistCredits?: MusicArtistCredit[] } } | null
  const raw = provider?.youtubeMusic
  const id = item.artistId || (raw?.artistId ? `ytmusic:${raw.artistId}` : null)
  const structured = item.artistCredits ?? raw?.artistCredits?.map(credit => ({ ...credit, id: credit.id ? `ytmusic:${credit.id}` : null }))
  return structured ? normalizeArtistCredits(name, id, structured)
    : plexArtistCredits(name, name === item.artistName ? id : null, name === item.artistName ? provider?.grandparent_guid ?? provider?.parent_guid : null)
}

export const artistCreditsKey = (name: string) => normalizeArtistCredits(name).map(credit => key(credit.name)).sort().join("; ")
export const itemArtistCreditsKey = (item: Parameters<typeof itemArtistCredits>[0]) => itemArtistCredits(item).map(credit => key(credit.name)).sort().join("; ")
