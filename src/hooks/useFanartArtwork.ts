import { useArtworkCache } from "./useArtworkCache"
import type { MetadataIdentity } from "../metadata/core/types"
import { useReviewedArtwork } from "./useReviewedArtwork"
import { useProviderStore } from "../stores/providerStore"
import { useFanartMetadataStore } from "../metadata/fanart/store"
import type { FanartAlbum } from "../metadata/fanart/store"
import type { FanartArtist } from "../metadata/services/api"
import { useFanartServiceStore } from "../metadata/services/store"
import { albumMatches } from "../metadata/albumMatch"
import {
  verifiedFanartCandidates,
  type ArtworkCandidate,
} from "../lib/artworkCandidates"
import { buildImageUrl } from "../lib/imageUrl"
import type { ArtworkRole } from "../stores/artworkPreferenceStore"

export function useFanartArtwork(
  kind: "artist" | "album",
  artist: string | null,
  title: string | null,
  entityId: string | null | undefined,
  role: ArtworkRole,
  scope: string | undefined,
  revise: (url: string | null) => string | null,
  allowFetch: boolean,
  reviewedIdentity?: MetadataIdentity
) {
  const reviewed = useReviewedArtwork(
    "fanart",
    reviewedIdentity ??
      (scope && artist
        ? {
            kind,
            artist,
            title: title ?? undefined,
            entityId: entityId ?? undefined,
            scope,
          }
        : null),
    allowFetch
  )
  const offline = useProviderStore((state) => state.provider?.isOffline)
  const status = useFanartServiceStore((s) => s.status)
  const loadStatus = useFanartServiceStore((s) => s.load)
  const enabled = !!status?.enabled && status.configured
  const { key, data, valid, pending } = useArtworkCache<
    FanartArtist,
    FanartAlbum
  >(useFanartMetadataStore, {
    kind,
    artist,
    title,
    enabled,
    allowFetch,
    offline,
    statusLoaded: !!status,
    loadStatus,
    reviewedChoice: !!reviewed.resolution?.choice,
    reviewedLease: reviewed.resolution?.lease,
    validate(artistEntry, albumEntry) {
      const data = artistEntry?.data ?? albumEntry?.data
      return (
        !!data?.mbid &&
        data.revision === status?.revision &&
        (kind === "artist"
          ? typeof artistEntry?.data?.name === "string" &&
            artistEntry.data.name.trim().toLowerCase() ===
              artist?.trim().toLowerCase()
          : !!albumEntry?.data &&
            albumMatches(albumEntry.data, artist ?? "", title ?? ""))
      )
    },
  })
  const activeData = reviewed.resolution?.choice ? reviewed.data : data
  const activeValid = reviewed.resolution?.choice ? !!reviewed.data : valid
  const posters = Array.isArray(activeData?.posters) ? activeData.posters : []
  const backgrounds = Array.isArray(activeData?.backgrounds)
    ? activeData.backgrounds
    : []
  const raw =
    activeValid && activeData
      ? role === "poster"
        ? posters
        : backgrounds.length
          ? backgrounds
          : verifiedFanartCandidates(posters).map((image) => ({
              ...image,
              label: `${image.label ?? "Cover"} reused as background`,
            }))
      : []
  const images: ArtworkCandidate[] = verifiedFanartCandidates(raw).map(
    (image) => ({
      ...image,
      provenance: "Fanart.tv · verified MusicBrainz identity",
      url: revise(
        buildImageUrl(
          kind,
          entityId ?? key,
          image.url,
          kind === "album" ? title : artist,
          kind === "album" ? artist : undefined,
          scope
        )
      )!,
    })
  )
  return {
    images,
    pending: reviewed.resolution?.choice ? reviewed.pending : pending,
    revision: status?.revision,
  }
}
