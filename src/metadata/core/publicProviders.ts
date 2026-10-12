import { useWikidataMetadataStore } from "../wikidata/store"
import { useCoverArtArchiveMetadataStore } from "../coverartarchive/store"
import type { MetadataAdapter } from "./types"
export function publicMetadataProviders(): MetadataAdapter[] {
  return [
    {
      id: "wikidata",
      fields: { artist: ["description", "wikipediaUrl", "externalUrl"] },
      transportPolicy:
        "Native exact-QID GET, reciprocal MusicBrainz identity, 1 request/sec, bounded admission and JSON; honors backoff.",
      lookup: async (identity) => {
        if (identity.kind !== "artist") return { status: "unsupported" }
        const result = await useWikidataMetadataStore
          .getState()
          .getArtist(identity.artist)
        if (
          !result ||
          result.name.trim().toLowerCase() !==
            identity.artist.trim().toLowerCase()
        )
          return { status: "unavailable" }
        return {
          status: "ready",
          snapshot: {
            source: "wikidata",
            identity,
            observedAt: Date.now(),
            match: {
              kind: "exact-name",
              reason:
                "Unique MusicBrainz artist relation and reciprocal Wikidata P434 agree.",
            },
            fields: {
              description: result.description ?? undefined,
              wikipediaUrl: result.wikipedia_url ?? undefined,
              externalUrl: `https://www.wikidata.org/wiki/${result.qid}`,
            },
          },
        }
      },
      invalidate: (identity) =>
        useWikidataMetadataStore.getState().invalidateArtist(identity.artist),
    },
    {
      id: "coverartarchive",
      fields: { album: ["artwork"] },
      transportPolicy:
        "Native exact-release-group GET after verified MusicBrainz artist/title; 1 request/sec, bounded admission and JSON; honors backoff.",
      lookup: async (identity) => {
        if (identity.kind !== "album") return { status: "unsupported" }
        const result = await useCoverArtArchiveMetadataStore
          .getState()
          .getAlbum(identity.artist, identity.title ?? "")
        if (!result) return { status: "unavailable" }
        return {
          status: "ready",
          snapshot: {
            source: "coverartarchive",
            identity,
            observedAt: Date.now(),
            match: {
              kind: "exact-name",
              reason:
                "Unique MusicBrainz release-group artist credit/title; approved CAA front cover.",
            },
            fields: { artwork: result.cover_url },
          },
        }
      },
      invalidate: (identity) =>
        useCoverArtArchiveMetadataStore
          .getState()
          .invalidateAlbum(identity.artist, identity.title ?? ""),
    },
  ]
}
