import type { MusicAlbum, MusicArtist, MusicTrack } from "../types/music"
import { itemArtistCredits } from "../lib/artistCredits"
import type { MatchingIdentifier, MatchingSource, MatchingExample } from "./resolverTypes"

export function matchingIdentifiers(guid?: string | null): MatchingIdentifier[] {
  if (!guid) return []
  // Generic mbid:// values are deliberately excluded: Plex often means a
  // release-track, not a recording. Only explicit entity types establish scope.
  const typed = /^(?:musicbrainz|mbid):\/\/(artist|recording|release|release-group)\/([0-9a-f-]{36})(?:\?.*)?$/i.exec(guid)
  if (typed && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(typed[2]))
    return [{ scheme: `musicbrainz:${typed[1].toLowerCase()}`, value: typed[2].toLowerCase() }]
  const plex = /^plex:\/\/(artist|album|track)\/([a-z0-9-]{1,128})$/i.exec(guid)
  if (plex) return [{ scheme: `plex:${plex[1].toLowerCase()}`, value: plex[2] }]
  return []
}
const empty = () => ({ identifiers: [] as MatchingIdentifier[], catalog: [] as MatchingExample[], trackList: [] as MatchingExample[] })
export function trackMatchingSource(track: MusicTrack): MatchingSource {
  return { ...empty(), id: track.id, kind: "track", title: track.title,
    artists: itemArtistCredits(track).map(credit => credit.name).sort(),
    identifiers: matchingIdentifiers(track.guid), album: track.albumName || null,
    duration: track.duration > 0 ? track.duration : null, explicit: track.explicit, year: track.year || null }
}
export function artistMatchingSource(artist: Pick<MusicArtist, "id" | "title"> & { guid?: string | null }, catalog: MatchingExample[] = []): MatchingSource {
  return { ...empty(), id: artist.id, kind: "artist", title: artist.title, artists: [], identifiers: matchingIdentifiers(artist.guid), catalog: catalog.slice(0, 64) }
}
export function albumMatchingSource(album: Pick<MusicAlbum, "id" | "title" | "artistName" | "year"> & Partial<MusicAlbum>, tracks: MatchingExample[] = []): MatchingSource {
  return { ...empty(), id: album.id, kind: "album", title: album.title,
    artists: itemArtistCredits({ ...album, artistId: album.artistId ?? null }).map(credit => credit.name).sort(),
    identifiers: matchingIdentifiers(album.guid), year: album.year || null, date: album.releaseDate || null,
    releaseType: album.format || null, trackList: tracks.slice(0, 100) }
}
