import type { MetadataAdapter } from "../core/types"
import { resolveMetadataIdentity } from "../identity/resolve"
import { theAudioDb, useTheAudioDbStore } from "./store"
export function theAudioDbAdapter(): MetadataAdapter {
  const status = useTheAudioDbStore.getState().status
  return {
    id: "theaudiodb",
    fields: {
      artist: [
        "biography",
        "genres",
        "tags",
        "area",
        "beginDate",
        "mbid",
        "externalUrl",
      ],
      album: [
        "summary",
        "genres",
        "tags",
        "releaseDate",
        "label",
        "mbid",
        "externalUrl",
      ],
      track: ["summary", "genres", "tags", "mbid", "externalUrl"],
    },
    transportPolicy:
      "Optional premium V2 native GETs; private header key, 1 request/sec, 60-second 429 backoff, six-hour memory-only positive cache, bounded exact identity verification.",
    invalidate: theAudioDb.invalidate,
    async lookup(identity) {
      if (!status?.enabled || !status.configured)
        return { status: "unavailable" }
      if (useTheAudioDbStore.getState().status?.revision !== status.revision)
        return { status: "retired" }
      const reviewed = resolveMetadataIdentity(identity)
      const mbid =
        identity.kind === "artist"
          ? reviewed.artistMbid
          : identity.kind === "album"
            ? reviewed.releaseGroupMbid
            : undefined
      try {
        const result = await theAudioDb.lookup(identity, mbid)
        if (useTheAudioDbStore.getState().status?.revision !== status.revision)
          return { status: "retired" }
        if (result.status === "ambiguous")
          return {
            ...result,
            reason: "Multiple TheAudioDB records match; none was selected.",
          }
        if (result.status !== "ready") return result
        return {
          status: "ready",
          snapshot: {
            source: "theaudiodb",
            identity: { ...identity },
            fields: result.item.fields,
            observedAt: Date.now(),
            fieldOrigins: Object.fromEntries(
              Object.keys(result.item.fields).map((field) => [
                field,
                "TheAudioDB · " + result.item.url,
              ])
            ),
            match: {
              kind: "exact-name",
              reason: mbid
                ? "Reviewed MusicBrainz ID and returned artist/title verified in TheAudioDB."
                : "Unique exact artist/title verified in search and ID detail.",
            },
          },
        }
      } catch {
        return { status: "error", code: "lookup-failed", retryable: true }
      }
    },
  }
}
