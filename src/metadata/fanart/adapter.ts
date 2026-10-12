import { useFanartMetadataStore } from "./store"
import type { MetadataAdapter } from "../core/types"
import { useFanartServiceStore } from "../services/store"
export const fanartMetadataAdapter: MetadataAdapter = {
  id: "fanart",
  fields: { artist: ["artwork"], album: ["artwork"] },
  transportPolicy:
    "Native fixed-origin authenticated Fanart GET anchored to MusicBrainz identities; shared 1 request/sec gate, no redirects, bounded output.",
  lookup: async (identity) => {
    if (identity.kind === "track") return { status: "unsupported" }
    const status = useFanartServiceStore.getState().status
    if (!status?.enabled || !status.configured) return { status: "unavailable" }
    const result =
      identity.kind === "artist"
        ? await useFanartMetadataStore.getState().getArtist(identity.artist)
        : await useFanartMetadataStore
            .getState()
            .getAlbum(identity.artist, identity.title ?? "")
    if (useFanartServiceStore.getState().status?.revision !== status.revision)
      return { status: "retired" }
    if (
      !result ||
      result.revision !== status.revision ||
      !result.posters.length
    )
      return { status: "unavailable" }
    return {
      status: "ready",
      snapshot: {
        source: "fanart",
        identity: { ...identity },
        fields: { artwork: result.posters[0].url },
        observedAt: Date.now(),
        match: {
          kind: "exact-name",
          reason:
            "Exact MusicBrainz artist or release-group identity and verified Fanart image record.",
        },
      },
    }
  },
  invalidate(identity) {
    if (identity.kind === "artist")
      useFanartMetadataStore.getState().invalidateArtist(identity.artist)
    else if (identity.kind === "album")
      useFanartMetadataStore
        .getState()
        .invalidateAlbum(identity.artist, identity.title ?? "")
  },
}
