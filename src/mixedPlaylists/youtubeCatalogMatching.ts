import type { MusicTrack } from "../types/music"
import type { YoutubeMusicBrowsePage, YoutubeMusicDestination, YoutubeMusicItem } from "../backends/ytmusic/discovery"
import { itemArtistCredits } from "../lib/artistCredits"
import { artistCatalogScore, artistNameKey, artistNameSimilarity, youtubeArtistEvidence } from "../lib/artistMatching"
import { playlistSearchTitle } from "../playlistSync/matching"
import { counterpartDeferred, counterpartFailure, selectPlaylistCounterpart } from "./matching"

const releaseCategories = new Set(["albums", "singles", "features", "live"])
const artistName = (track: MusicTrack) => itemArtistCredits(track)[0]?.name ?? ""
const groupKey = (track: MusicTrack) => artistNameKey(artistName(track))
const releaseName = (name: string) => name.replace(/\s*(?:[-–—]\s*|\(\s*)(?:single|ep)\s*\)?$/iu, "").trim()
const releaseScore = (track: MusicTrack, release: YoutubeMusicItem) => Math.max(
  artistNameSimilarity(releaseName(track.albumName), releaseName(release.title)),
  artistNameSimilarity(playlistSearchTitle({ id: track.id, title: track.title, artist: artistName(track) }), releaseName(release.title)) - 0.05,
)
interface ArtistCatalog {
  page: YoutubeMusicBrowsePage
  releases: Map<string, YoutubeMusicItem>
  songs: Map<string, MusicTrack>
  expansion?: Promise<void>
}

/** One artist search and shared release pages for a playlist job. Only relevant
 * albums/singles/EPs are opened; their complete track lists serve every song in
 * the group. Native browse supplies account-scoped persistent SWR and pacing. */
export function createYoutubeCatalogMatcher(tracks: MusicTrack[], options: {
  current(): boolean
  browse(destination: YoutubeMusicDestination, cursor: string | null): Promise<YoutubeMusicBrowsePage>
  toTrack(item: YoutubeMusicItem): MusicTrack
  knownArtists?(tracks: MusicTrack[]): Promise<string[]>
}) {
  const groups = new Map<string, MusicTrack[]>()
  for (const track of tracks) {
    const key = groupKey(track)
    if (key && key !== "variousartists") {
      const group = groups.get(key)
      if (group) group.push(track)
      else groups.set(key, [track])
    }
  }
  const pages = new Map<string, Promise<YoutubeMusicBrowsePage>>()
  const artists = new Map<string, Promise<ArtistCatalog | null>>()
  const albums = new Map<string, Promise<MusicTrack[]>>()
  const check = () => { if (!options.current()) throw Error("Music accounts changed.") }
  const read = async (destination: YoutubeMusicDestination, cursor: string | null = null) => {
    check()
    const key = JSON.stringify([destination.browseId, destination.params ?? null, cursor])
    let pending = pages.get(key)
    if (!pending) {
      pending = options.browse(destination, cursor); pages.set(key, pending)
    }
    const page = await pending
    check()
    return page
  }
  const optionalRead = async (destination: YoutubeMusicDestination, cursor: string | null = null) => {
    try { return await read(destination, cursor) }
    catch (failure) {
      check()
      if (counterpartDeferred(counterpartFailure(failure))) throw failure
      return null
    }
  }
  const collect = (catalog: ArtistCatalog, page: YoutubeMusicBrowsePage) => {
    for (const item of [...page.items, ...page.hubs.filter(hub => releaseCategories.has(hub.category) || hub.category === "songs").flatMap(hub => hub.items)]) {
      if (item.kind === "album" && item.id.startsWith("MPRE")) catalog.releases.set(item.id, { ...item,
        artist: item.artist || catalog.page.artist!.name, artistId: item.artistId || catalog.page.artist!.id })
      if (item.kind === "song" && item.artist && item.videoType !== "MUSIC_VIDEO_TYPE_OMV") {
        const track = options.toTrack(item)
        catalog.songs.set(track.id, track)
      }
    }
  }
  const loadArtist = async (group: MusicTrack[]): Promise<ArtistCatalog | null> => {
    const name = artistName(group[0])
    const reference = { songs: group.map(track => ({ title: track.title, duration: track.duration })),
      releases: [...new Map(group.filter(track => track.albumName).map(track => [releaseName(track.albumName), { title: releaseName(track.albumName), year: track.albumYear }])).values()] }
    const candidates: { page: YoutubeMusicBrowsePage; similarity: number; overlap: number }[] = []
    const inspect = async (id: string, known = false) => {
      const page = await optionalRead({ browseId: id.replace(/^ytmusic:/u, "") })
      if (!page?.artist) return
      const similarity = artistNameSimilarity(name, page.artist.name)
      if (known || similarity >= 0.82) candidates.push({ page, similarity, overlap: artistCatalogScore(reference, youtubeArtistEvidence(page)) })
    }
    const known = [...new Set(await options.knownArtists?.(group) ?? [])].filter(id => /^(?:ytmusic:)?UC[\w-]+$/u.test(id)).slice(0, 3)
    check()
    for (const id of known) await inspect(id, true)
    if (!candidates.length) {
      const results = await optionalRead({ browseId: "hibiki_artist_search", params: name })
      const matches = [...new Map((results?.items ?? []).filter(item => item.kind === "artist" && artistNameSimilarity(name, item.title) >= 0.82)
        .map(item => [item.id, item])).values()].sort((a, b) => artistNameSimilarity(name, b.title) - artistNameSimilarity(name, a.title)).slice(0, 3)
      for (const item of matches) await inspect(item.id)
    }
    candidates.sort((a, b) => b.overlap - a.overlap || b.similarity - a.similarity)
    if (!candidates.length) return null
    const catalog: ArtistCatalog = { page: candidates[0].page, releases: new Map(), songs: new Map() }
    collect(catalog, catalog.page)
    return catalog
  }
  const choices = (catalog: ArtistCatalog, track: MusicTrack) => [...catalog.releases.values()]
    .filter(release => releaseScore(track, release) >= 0.82).sort((a, b) => releaseScore(track, b) - releaseScore(track, a))
  const expand = (catalog: ArtistCatalog, group: MusicTrack[]) => {
    if (catalog.expansion) return catalog.expansion
    const work = (async () => {
      const tasks = catalog.page.hubs.filter(hub => releaseCategories.has(hub.category) && (hub.destination || hub.continuation))
        .map(hub => ({ destination: hub.destination ?? { browseId: catalog.page.artist!.id },
          cursor: hub.destination ? null : hub.continuation, visited: new Set<string | null>() }))
      // Paginate release listings, not every album's contents. Stop as soon as the
      // requested releases are present, or after a bounded round-robin traversal.
      for (let count = 0; tasks.length && count < 12 && group.some(track => !choices(catalog, track).length); count++) {
        const task = tasks.shift()!
        if (task.visited.has(task.cursor)) continue
        task.visited.add(task.cursor)
        const page = await optionalRead(task.destination, task.cursor)
        if (!page) continue
        collect(catalog, page)
        if (page.continuation && !task.visited.has(page.continuation)) tasks.push({ ...task, cursor: page.continuation })
      }
    })()
    catalog.expansion = work
    return work
  }
  const releaseTracks = (release: YoutubeMusicItem) => {
    let pending = albums.get(release.id)
    if (!pending) {
      pending = (async () => {
        const songs = new Map<string, MusicTrack>(), seen = new Set<string | null>()
        let cursor: string | null = null
        for (let count = 0; count < 10 && !seen.has(cursor); count++) {
          seen.add(cursor)
          const page = await optionalRead({ browseId: release.id }, cursor)
          if (!page) break
          for (const item of page.items) if (item.kind === "song" && item.videoType !== "MUSIC_VIDEO_TYPE_OMV") {
            const track = options.toTrack({ ...item, album: item.album || page.title || release.title, albumId: item.albumId || release.id,
              artist: item.artist || release.artist, artistCredits: item.artistCredits?.length ? item.artistCredits : undefined,
              artistId: item.artistId || (!item.artist ? release.artistId : null),
              thumbnail: item.thumbnail || page.thumbnail || release.thumbnail })
            songs.set(track.id, track)
          }
          cursor = page.continuation
          if (!cursor || songs.size >= 1000) break
        }
        return [...songs.values()]
      })()
      albums.set(release.id, pending)
    }
    return pending
  }
  return async (track: MusicTrack): Promise<MusicTrack[]> => {
    check()
    const key = groupKey(track), group = groups.get(key)
    if (!group) return []
    let pending = artists.get(key)
    if (!pending) { pending = loadArtist(group); artists.set(key, pending) }
    const catalog = await pending
    check()
    if (!catalog) return []
    const found = new Map(catalog.songs)
    const selected = () => selectPlaylistCounterpart(track, [...found.values()])
    if ((selected()?.confidence ?? 0) >= 0.94) return [...found.values()]
    if (!choices(catalog, track).length) await expand(catalog, group)
    const inspected = new Set<string>()
    const inspect = async () => {
      for (const release of choices(catalog, track).slice(0, 3)) {
        if (inspected.has(release.id)) continue
        inspected.add(release.id)
        for (const song of await releaseTracks(release)) { found.set(song.id, song); catalog.songs.set(song.id, song) }
        if (selected()) break
      }
    }
    await inspect()
    if (!selected() && !catalog.expansion) { await expand(catalog, group); await inspect() }
    check()
    return [...found.values()]
  }
}
