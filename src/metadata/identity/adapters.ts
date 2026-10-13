import { invoke } from "@tauri-apps/api/core"
import type {
  MetadataAdapter,
  MetadataResult,
  MetadataFields,
} from "../core/types"
import type { MetadataIdentityResolution } from "./types"
import { reviewMusicBrainzIdentity } from "./api"
import { useHeyaServiceStore, useFanartServiceStore } from "../services/store"
import type { HeyaLookup } from "../heya/adapter"
import { fanartGetArtist, fanartGetAlbum } from "../services/api"
import { theAudioDb, useTheAudioDbStore } from "../theaudiodb/store"
/** A reviewed ID is authoritative only for providers with an accepted cross-ID.
 * Name-only services retain Automatic behavior until reset; no homonym is
 * silently promoted to an ID-verified match. Original Plex identity is retained. */
export function reviewedIdentityAdapters(
  adapters: readonly MetadataAdapter[],
  resolution: MetadataIdentityResolution
): MetadataAdapter[] {
  if (!resolution.choice) return [...adapters]
  return adapters.map((adapter) => ({
    ...adapter,
    invalidate: () => {},
    lookup: async (identity): Promise<MetadataResult> => {
      const choice = resolution.choice!
      if (identity.kind === "track") return { status: "unsupported" }
      let fields: Partial<MetadataFields> = {},
        fieldOrigins
      if (adapter.id === "musicbrainz") {
        const id =
          identity.kind === "artist"
            ? resolution.artistMbid
            : resolution.releaseGroupMbid
        if (!id) return { status: "unavailable" }
        const review = await reviewMusicBrainzIdentity(identity.kind, id)
        if (
          review.candidate.id !== id ||
          review.candidate.kind !== identity.kind
        )
          return { status: "unavailable" }
        fields = review.fields
        fieldOrigins = review.fieldOrigins
      } else if (adapter.id === "theaudiodb") {
        const status = useTheAudioDbStore.getState().status
        if (!status?.enabled || !status.configured)
          return { status: "unavailable" }
        const mbid =
          identity.kind === "artist"
            ? resolution.artistMbid
            : resolution.releaseGroupMbid
        const result = await theAudioDb.lookup(
          {
            ...identity,
            artist: resolution.lookupArtist,
            title: resolution.lookupTitle,
          },
          mbid
        )
        if (useTheAudioDbStore.getState().status?.revision !== status.revision)
          return { status: "retired" }
        if (result.status === "ambiguous")
          return {
            ...result,
            reason: "Multiple TheAudioDB identities match; none was chosen.",
          }
        if (result.status !== "ready") return result
        fields = result.item.fields
        fieldOrigins = Object.fromEntries(
          Object.keys(fields).map((field) => [
            field,
            "TheAudioDB · " + result.item.url,
          ])
        )
      } else if (adapter.id === "heya") {
        const status = useHeyaServiceStore.getState().status
        if (!status?.enabled || !status.configured)
          return { status: "unavailable" }
        const mbid =
          identity.kind === "artist"
            ? resolution.artistMbid
            : resolution.releaseGroupMbid
        if (!resolution.heyaId && !mbid) return { status: "unavailable" }
        const result = await invoke<HeyaLookup>("heya_get_metadata", {
          revision: status.revision,
          kind: identity.kind,
          artist: identity.artist,
          title: identity.title ?? null,
          mbid: mbid ?? null,
          selectedId: resolution.heyaId ?? null,
          selectedConnectionId: resolution.connectionId ?? null,
        })
        if (useHeyaServiceStore.getState().status?.revision !== status.revision)
          return { status: "retired" }
        if (result.status !== "ready")
          return result.status === "ambiguous"
            ? {
                status: "ambiguous",
                candidates: result.candidates,
                reason:
                  "Multiple canonical identities match the reviewed MusicBrainz ID.",
              }
            : { status: "unavailable" }
        if (
          result.item.revision !== status.revision ||
          (resolution.heyaId && result.item.id !== resolution.heyaId)
        )
          return { status: "unavailable" }
        fields = result.item.fields
        fieldOrigins = result.item.fieldOrigins
      } else if (adapter.id === "coverartarchive") {
        if (identity.kind !== "album" || !resolution.releaseGroupMbid)
          return { status: "unsupported" }
        const result = await invoke<{ cover_url: string } | null>(
          "coverartarchive_get_album",
          { releaseGroupMbid: resolution.releaseGroupMbid }
        )
        if (!result) return { status: "unavailable" }
        fields = { artwork: result.cover_url }
      } else if (adapter.id === "fanart") {
        const status = useFanartServiceStore.getState().status
        if (!status?.enabled || !status.configured)
          return { status: "unavailable" }
        if (identity.kind === "album" && resolution.releaseGroupMbid) {
          const item = await fanartGetAlbum(
            status.revision,
            resolution.releaseGroupMbid,
            resolution.artistMbid
          )
          if (
            useFanartServiceStore.getState().status?.revision !==
            status.revision
          )
            return { status: "retired" }
          if (
            !item ||
            item.mbid !== resolution.releaseGroupMbid ||
            item.revision !== status.revision ||
            !item.posters[0]
          )
            return { status: "unavailable" }
          return {
            status: "ready",
            snapshot: {
              source: "fanart",
              identity: { ...identity },
              fields: { artwork: item.posters[0].url },
              observedAt: Date.now(),
              match: {
                kind: "reviewed-identity",
                reason:
                  "Explicitly reviewed release-group identity verified by Fanart.tv.",
              },
            },
          }
        }
        if (!status?.enabled || !status.configured || !resolution.artistMbid)
          return { status: "unavailable" }
        const result = await fanartGetArtist(
          status.revision,
          resolution.artistMbid
        )
        if (
          useFanartServiceStore.getState().status?.revision !== status.revision
        )
          return { status: "retired" }
        if (!result || result.mbid !== resolution.artistMbid)
          return { status: "unavailable" }
        const image =
          identity.kind === "artist"
            ? result.posters[0]
            : result.albums.find(
                (album) => album.mbid === resolution.releaseGroupMbid
              )?.posters[0]
        if (!image) return { status: "unavailable" }
        fields = { artwork: image.url }
      } else if (adapter.id === "wikidata") {
        if (
          identity.kind !== "artist" ||
          !resolution.artistMbid ||
          !choice.identifiers.wikidataQid
        )
          return { status: "unavailable" }
        const result = await invoke<{
          description: string | null
          wikipedia_url: string | null
        } | null>("wikidata_get_artist", {
          qid: choice.identifiers.wikidataQid,
          artistMbid: resolution.artistMbid,
        })
        if (!result) return { status: "unavailable" }
        fields = {
          description: result.description ?? undefined,
          wikipediaUrl: result.wikipedia_url ?? undefined,
        }
      } else {
        const result = await adapter.lookup({
          ...identity,
          artist: resolution.lookupArtist,
          title:
            identity.kind === "album" ? resolution.lookupTitle : identity.title,
        })
        if (result.status !== "ready") return result
        if (
          result.snapshot.identity.artist.trim().toLowerCase() !==
            resolution.lookupArtist.trim().toLowerCase() ||
          (identity.kind === "album" &&
            result.snapshot.identity.title?.trim().toLowerCase() !==
              resolution.lookupTitle?.trim().toLowerCase())
        )
          return { status: "unavailable" }
        return {
          status: "ready",
          snapshot: {
            ...result.snapshot,
            identity: { ...identity },
            match: {
              ...result.snapshot.match,
              reason: `Reviewed canonical names; ${result.snapshot.match.reason}`,
            },
          },
        }
      }
      return {
        status: "ready",
        snapshot: {
          source: adapter.id,
          identity: { ...identity },
          fields,
          fieldOrigins,
          observedAt: Date.now(),
          match: {
            kind: "reviewed-identity",
            reason: `Explicitly reviewed ${choice.provider} canonical identity; accepted provider identifier.`,
          },
        },
      }
    },
  }))
}
