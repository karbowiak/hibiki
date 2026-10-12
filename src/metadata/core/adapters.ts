import { albumMatches } from "../albumMatch"
import type { DeezerArtistInfo, DeezerAlbumInfo } from "../deezer/api"
import type { ItunesArtistInfo, ItunesAlbumInfo } from "../apple/api"
import type {
  LastfmArtistInfo,
  LastfmAlbumInfo,
  LastfmTrackInfo,
} from "../lastfm/api"
import type {
  MusicBrainzArtistInfo,
  MusicBrainzAlbumInfo,
} from "../musicbrainz/api"
import type { MusicArtist, MusicAlbum, MusicTrack } from "../../types/music"
import type {
  MetadataAdapter,
  MetadataFields,
  MetadataIdentity,
  MetadataMatch,
  MetadataResult,
} from "./types"
const name = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase()
const exactArtist = (returned: string, identity: MetadataIdentity) =>
  !!name(identity.artist) && name(returned) === name(identity.artist)
const exactAlbum = (
  artist: string,
  title: string,
  identity: MetadataIdentity
) => albumMatches({ artist, title }, identity.artist, identity.title ?? "")
const exact: MetadataMatch = {
  kind: "exact-name",
  reason:
    "Returned names match the requested identity; homonyms remain possible.",
}
function ready(
  source: MetadataAdapter["id"],
  identity: MetadataIdentity,
  fields: Partial<MetadataFields>,
  match = exact
): MetadataResult {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(
      ([, value]) => value !== null && value !== undefined && value !== ""
    )
  )
  return {
    status: "ready",
    snapshot: {
      source,
      identity: { ...identity },
      fields: clean,
      match,
      observedAt: Date.now(),
    },
  }
}
export interface ExistingMetadataReaders {
  deezer: {
    artist(name: string): Promise<DeezerArtistInfo | null>
    album(artist: string, title: string): Promise<DeezerAlbumInfo | null>
  }
  apple: {
    artist(name: string): Promise<ItunesArtistInfo | null>
    album(artist: string, title: string): Promise<ItunesAlbumInfo | null>
  }
  lastfm: {
    artist(name: string): Promise<LastfmArtistInfo | null>
    album(artist: string, title: string): Promise<LastfmAlbumInfo | null>
    track(artist: string, title: string): Promise<LastfmTrackInfo | null>
  }
  musicbrainz: {
    artist(name: string): Promise<MusicBrainzArtistInfo | null>
    album(artist: string, title: string): Promise<MusicBrainzAlbumInfo | null>
  }
}
/** Existing stores return null for both missing matches and failed I/O. Preserve that
 * uncertainty as unavailable rather than claiming "not found" or caching a failure. */
export function createExistingMetadataAdapters(
  readers: ExistingMetadataReaders
): MetadataAdapter[] {
  return [
    {
      id: "deezer",
      transportPolicy:
        "Existing public transport/cache; no additional polling.",
      fields: {
        artist: ["artwork", "fans", "externalUrl"],
        album: [
          "artwork",
          "genres",
          "fans",
          "releaseDate",
          "label",
          "externalUrl",
        ],
      },
      async lookup(identity) {
        if (identity.kind === "track") return { status: "unsupported" }
        if (identity.kind === "artist") {
          const data = await readers.deezer.artist(identity.artist)
          if (!data || !exactArtist(data.name, identity))
            return { status: "unavailable" }
          return ready("deezer", identity, {
            artwork: data.image_url ?? undefined,
            fans: data.fans,
            externalUrl: data.deezer_url,
          })
        }
        const data = await readers.deezer.album(
          identity.artist,
          identity.title ?? ""
        )
        if (!data || !exactAlbum(data.artist, data.title, identity))
          return { status: "unavailable" }
        return ready("deezer", identity, {
          artwork: data.cover_url ?? undefined,
          genres: data.genres,
          fans: data.fans,
          releaseDate: data.release_date,
          label:
            data.label.trim().toLowerCase() === "[no label]"
              ? undefined
              : data.label,
          externalUrl: data.deezer_url,
        })
      },
    },
    {
      id: "apple",
      transportPolicy:
        "iTunes Search: existing common native 3-second admission gate, cooldown/retries and public cache.",
      fields: {
        artist: ["genres", "externalUrl"],
        album: [
          "artwork",
          "genres",
          "releaseDate",
          "trackCount",
          "externalUrl",
        ],
      },
      async lookup(identity) {
        if (identity.kind === "track") return { status: "unsupported" }
        if (identity.kind === "artist") {
          const data = await readers.apple.artist(identity.artist)
          if (!data || !exactArtist(data.name, identity))
            return { status: "unavailable" }
          return ready("apple", identity, {
            genres: data.genre ? [data.genre] : [],
            externalUrl: data.apple_music_url,
          })
        }
        const data = await readers.apple.album(
          identity.artist,
          identity.title ?? ""
        )
        if (!data || !exactAlbum(data.artist, data.title, identity))
          return { status: "unavailable" }
        return ready("apple", identity, {
          artwork: data.cover_url ?? undefined,
          genres: data.genre ? [data.genre] : [],
          releaseDate: data.release_date,
          trackCount: data.track_count,
          externalUrl: data.apple_music_url,
        })
      },
    },
    {
      id: "lastfm",
      transportPolicy:
        "Existing API-key-owned public metadata cache; no scrobble/auth/playlist operations.",
      fields: {
        artist: [
          "biography",
          "tags",
          "listeners",
          "playCount",
          "similarArtists",
          "externalUrl",
        ],
        album: ["summary", "tags"],
        track: ["summary", "tags", "listeners", "playCount"],
      },
      async lookup(identity) {
        if (identity.kind === "artist") {
          const data = await readers.lastfm.artist(identity.artist)
          if (!data || !exactArtist(data.name, identity))
            return { status: "unavailable" }
          return ready("lastfm", identity, {
            biography: data.bio,
            tags: data.tags,
            listeners: data.listeners,
            playCount: data.play_count,
            externalUrl: data.url,
            similarArtists: data.similar.map((item) => ({
              name: item.name,
              url: item.url,
              image: item.image_url,
            })),
          })
        }
        if (identity.kind === "album") {
          const data = await readers.lastfm.album(
            identity.artist,
            identity.title ?? ""
          )
          if (!data || !exactAlbum(data.artist, data.name, identity))
            return { status: "unavailable" }
          return ready("lastfm", identity, {
            summary: data.wiki ?? undefined,
            tags: data.tags,
          })
        }
        const data = await readers.lastfm.track(
          identity.artist,
          identity.title ?? ""
        )
        if (
          !data ||
          !exactArtist(data.artist, identity) ||
          name(data.name) !== name(identity.title ?? "")
        )
          return { status: "unavailable" }
        return ready("lastfm", identity, {
          summary: data.wiki ?? undefined,
          tags: data.tags,
          listeners: data.listeners,
          playCount: data.play_count,
        })
      },
    },
    {
      id: "musicbrainz",
      transportPolicy:
        "Existing shared native 1 HTTP request/second gate and identifying User-Agent.",
      fields: {
        artist: [
          "mbid",
          "artistType",
          "area",
          "tags",
          "beginDate",
          "wikipediaUrl",
        ],
        album: ["mbid", "releaseDate", "tags"],
      },
      async lookup(identity) {
        if (identity.kind === "track") return { status: "unsupported" }
        if (identity.kind === "artist") {
          const data = await readers.musicbrainz.artist(identity.artist)
          if (!data || !exactArtist(data.name, identity))
            return { status: "unavailable" }
          return ready("musicbrainz", identity, {
            mbid: data.mbid,
            artistType: data.artist_type ?? undefined,
            area: data.area ?? undefined,
            tags: data.tags,
            beginDate: data.begin_date ?? undefined,
            wikipediaUrl: data.wikipedia_url ?? undefined,
          })
        }
        const data = await readers.musicbrainz.album(
          identity.artist,
          identity.title ?? ""
        )
        if (!data || name(data.title) !== name(identity.title ?? "") || name(data.artist ?? "") !== name(identity.artist))
          return { status: "unavailable" }
        // Older persisted records omit artist credit and were rejected above.
        return ready(
          "musicbrainz",
          identity,
          {
            mbid: data.mbid,
            releaseDate: data.first_release_date ?? undefined,
            tags: data.tags,
          },
          {
            kind: "exact-name",
            reason: "MusicBrainz returned one exact album title and artist credit match.",
          }
        )
      },
    },
  ]
}
/** A caller supplies its already-owned library model; this performs no fetch/write. */
export function libraryMetadataSnapshot(
  identity: MetadataIdentity,
  item: MusicArtist | MusicAlbum | MusicTrack
): MetadataResult {
  if (
    !identity.entityId ||
    item.id !== identity.entityId ||
    (identity.kind === "artist"
      ? name(item.title) !== name(identity.artist)
      : name(item.title) !== name(identity.title ?? ""))
  )
    return { status: "unavailable" }
  if (
    identity.kind !== "artist" &&
    (!("artistName" in item) || !exactArtist(item.artistName, identity))
  )
    return { status: "unavailable" }
  const fields: Partial<MetadataFields> = {
    title: item.title,
    artist: identity.artist,
    summary: item.summary ?? undefined,
    artwork: item.thumbUrl ?? undefined,
  }
  if (identity.kind === "artist") fields.biography = item.summary ?? undefined
  if ("genres" in item)
    Object.assign(fields, {
      genres: item.genres,
      tags: [
        ...new Set([
          ...(Array.isArray(item.styles)
            ? item.styles.filter((value) => typeof value === "string")
            : []),
          ...(Array.isArray(item.moods)
            ? item.moods.filter((value) => typeof value === "string")
            : []),
        ]),
      ],
      label: item.studio ?? undefined,
      releaseDate: item.releaseDate,
      trackCount: item.trackCount,
    })
  return ready("plex", identity, fields, {
    kind: "library",
    reason: "Current library scope and entity ID supplied by the owning view.",
  })
}
