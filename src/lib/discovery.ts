import type { MusicHub, MusicItem } from "../types/music"
import type { YoutubeMusicHub, YoutubeMusicItem } from "../backends/ytmusic/discovery"
import { artistNameKey } from "./artistMatching"

export type DiscoveryItem = { source: "plex"; item: MusicItem } | { source: "ytmusic"; item: YoutubeMusicItem }
export const plexDiscoveryItems = (items: MusicItem[]): DiscoveryItem[] => items.map(item => ({ source: "plex", item }))
export const youtubeDiscoveryItems = (items: YoutubeMusicItem[]): DiscoveryItem[] => items.map(item => ({ source: "ytmusic", item }))
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
function albumKey(entry: DiscoveryItem) {
  if (entry.source === "plex" && entry.item.type === "artist") return `artist:${artistNameKey(entry.item.title)}`
  if (entry.source === "ytmusic" && entry.item.kind === "artist") return `artist:${artistNameKey(entry.item.title)}`
  if (entry.source === "plex" && (entry.item.type === "album" || entry.item.type === "track")) return `${entry.item.type === "track" ? "song" : "album"}:${normalize(entry.item.artistName)}:${normalize(entry.item.title)}`
  if (entry.source === "ytmusic" && entry.item.kind !== "playlist" && entry.item.artist) return `${entry.item.kind}:${normalize(entry.item.artist)}:${normalize(entry.item.title)}`
  return null
}

/** Sort known release dates, weaving incomplete dates into their year in feed order. */
export function sortLatestReleases(items: DiscoveryItem[], currentYear = new Date().getFullYear()) {
  const date = (entry: DiscoveryItem) => {
    const release = entry.source === "plex" && entry.item.type === "album" ? entry.item.releaseDate
      : entry.source === "ytmusic" ? entry.item.releaseDate : null
    const valid = release && /^\d{4}-\d{2}-\d{2}$/.test(release) && Number.isFinite(Date.parse(release)) ? release : null
    const year = valid ? Number(valid.slice(0, 4)) : entry.source === "plex" && "year" in entry.item ? entry.item.year
      : entry.source === "ytmusic" ? entry.item.year ?? 0 : 0
    return { year: year || currentYear, release: valid ?? "" }
  }
  const years = new Map<number, { dated: { entry: DiscoveryItem; release: string }[]; partial: DiscoveryItem[] }>()
  for (const entry of items) {
    const { year, release } = date(entry)
    const group = years.get(year) ?? { dated: [], partial: [] }
    if (release) group.dated.push({ entry, release })
    else group.partial.push(entry)
    years.set(year, group)
  }
  return [...years].sort(([a], [b]) => b - a).flatMap(([, group]) => {
    const dated = group.dated.sort((a, b) => b.release.localeCompare(a.release))
    const result: DiscoveryItem[] = []
    // Year-only entries cannot be ordered to the day. Keep their provider order,
    // without placing an entire provider after all dated releases. A new-release
    // recommendation with no year joins the current batch; no date is invented.
    for (let i = 0; i < Math.max(dated.length, group.partial.length); i++) {
      if (dated[i]) result.push(dated[i].entry)
      if (group.partial[i]) result.push(group.partial[i])
    }
    return result
  })
}
/** Keep Plex editions in preference to the same release from YouTube Music. */
export function mergeDiscoveryItems(plex: DiscoveryItem[], youtube: DiscoveryItem[], associations?: ReadonlyMap<string, string | null>) {
  const albums = new Set(plex.map(albumKey).filter(Boolean))
  const seen = new Set<string>()
  const remote = youtube.filter(entry => {
    const key = `${entry.source}:${entry.item.id}`
    const sourceId = entry.source === "ytmusic" ? `ytmusic:${entry.item.id}` : entry.item.id
    const duplicate = associations?.has(sourceId) ? plex.some(known => known.item.id === associations.get(sourceId)) : albums.has(albumKey(entry))
    if (seen.has(key) || duplicate) return false
    seen.add(key)
    return true
  })
  const items: DiscoveryItem[] = []
  for (let index = 0; index < Math.max(plex.length, remote.length); index++) {
    if (plex[index]) items.push(plex[index])
    if (remote[index]) items.push(remote[index])
  }
  return items
}

export const isRecentlyPlayedHub = (hub: MusicHub) => /recent(?:ly)?[. _-]*played|last[. _-]*played/i.test(`${hub.identifier} ${hub.title}`)
export function hubPurpose(title: string) {
  const value = normalize(title)
  if (/rediscover|forgotten|old favorites|old favourites/.test(value)) return "rediscover"
  if (/biggest hits|popular|trending/.test(value)) return "popular"
  if (/favorites|favourites/.test(value)) return "favorites"
  return value
}
export function matchingYoutubeHubs(hub: MusicHub, youtube: YoutubeMusicHub[]) {
  return youtube.filter(remote => remote.category === "music" && hubPurpose(remote.title) === hubPurpose(hub.title))
}

export function mixDiscoveryItems(plex: MusicItem[], youtube: YoutubeMusicHub[]) {
  const ranked = youtube.filter(hub => hub.category === "mixes").map((hub, index) => ({ hub, index,
    priority: /\bmix(?:ed)? for you\b/i.test(hub.title) ? 0 : 1 }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
  const interleaved = mergeDiscoveryItems(plexDiscoveryItems(plex), youtubeDiscoveryItems(ranked.flatMap(({ hub }) => hub.items.filter(item => item.kind === "playlist"))))
  if (ranked[0]?.priority === 0 && interleaved[0]?.source === "plex" && interleaved[1]?.source === "ytmusic")
    [interleaved[0], interleaved[1]] = [interleaved[1], interleaved[0]]
  return interleaved
}
export function homeDiscoverySections(plex: MusicHub[], youtube: YoutubeMusicHub[], associations?: ReadonlyMap<string, string | null>) {
  const remaining = youtube.filter(hub => hub.category === "music")
  const result: { id: string; title: string; items: DiscoveryItem[]; href: string }[] = []
  const remoteSection = (hub: YoutubeMusicHub) => ({ id: hub.id, title: hub.title,
    items: youtubeDiscoveryItems(hub.items), href: `/hub/${encodeURIComponent(hub.id)}` })
  for (const hub of plex) {
    const matches = matchingYoutubeHubs(hub, remaining)
    matches.forEach(match => remaining.splice(remaining.indexOf(match), 1))
    result.push({ id: hub.identifier, title: hub.title,
      items: mergeDiscoveryItems(plexDiscoveryItems(hub.items), youtubeDiscoveryItems(matches.flatMap(match => match.items)), associations),
      href: `/hub/${encodeURIComponent(hub.identifier)}` })
    // Keep a matching remote shelf for its Plex partner later in the page.
    const standalone = remaining.findIndex(remote => !plex.some(candidate => matchingYoutubeHubs(candidate, [remote]).length))
    if (standalone >= 0) result.push(remoteSection(remaining.splice(standalone, 1)[0]))
  }
  result.push(...remaining.map(remoteSection))
  return result
}

export function recentDiscoveryItems(plex: MusicItem[], youtube: YoutubeMusicItem[], associations?: ReadonlyMap<string, string | null>) {
  const recent = new Map<string, number>()
  for (const item of youtube) {
    const key = albumKey({ source: "ytmusic", item })
    if (key && item.playedAt) recent.set(key, Math.max(recent.get(key) ?? 0, item.playedAt))
  }
  const items = mergeDiscoveryItems(plexDiscoveryItems(plex), youtubeDiscoveryItems(youtube), associations)
  const timestamp = (entry: DiscoveryItem) => entry.source === "ytmusic" ? entry.item.playedAt ?? 0
    : Math.max(recent.get(albumKey(entry) ?? "") ?? 0,
      "lastPlayedAt" in entry.item && entry.item.lastPlayedAt ? Date.parse(entry.item.lastPlayedAt) || 0 : 0)
  // Explicit local/server timestamps lead; untimed recommendations retain their
  // provider order behind actual listening history.
  return items.sort((a, b) => timestamp(b) - timestamp(a))
}
