import { useArtworkCache } from "./useArtworkCache"
import type { MetadataIdentity } from "../metadata/core/types"
import { useReviewedArtwork } from "./useReviewedArtwork"
import { useProviderStore } from "../stores/providerStore"
import { useHeyaArtworkStore } from "../metadata/heya/artworkStore"
import type { HeyaArtwork } from "../metadata/heya/artworkStore"
import { useHeyaServiceStore } from "../metadata/services/store"
import { albumMatches } from "../metadata/albumMatch"
import {
  verifiedHeyaCandidates,
  type ArtworkCandidate,
} from "../lib/artworkCandidates"
import { buildImageUrl } from "../lib/imageUrl"
import type { ArtworkRole } from "../stores/artworkPreferenceStore"

export function useHeyaArtwork(
  kind: "artist" | "album",
  artist: string | null,
  title: string | null,
  entityId: string | null | undefined,
  role: ArtworkRole,
  scope: string | undefined,
  revise: (url: string | null) => string | null,
  allowFetch: boolean,
  reviewedIdentity?: MetadataIdentity,
  offlineCandidateId?: string
) {
  const reviewed = useReviewedArtwork(
    "heya",
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
  const currentScope = useProviderStore((state) => state.provider?.cacheScope)
  const offline = useProviderStore((state) => state.provider?.isOffline)
  const status = useHeyaServiceStore((s) => s.status)
  const loadStatus = useHeyaServiceStore((s) => s.load)
  const enabled = !!status?.enabled && status.configured
  const { key, data, valid, pending } = useArtworkCache<
    HeyaArtwork,
    HeyaArtwork
  >(useHeyaArtworkStore, {
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
    maxAge: 30 * 60_000,
    validate(artistEntry, albumEntry) {
      const data = artistEntry?.data ?? albumEntry?.data
      return (
        !!data?.id &&
        data.revision === status?.revision &&
        (kind === "artist"
          ? typeof artistEntry?.data?.artist === "string" &&
            artistEntry.data.artist.trim().toLowerCase() ===
              artist?.trim().toLowerCase()
          : !!albumEntry?.data &&
            albumMatches(albumEntry.data, artist ?? "", title ?? ""))
      )
    },
  })
  const offlineSaved =
    offline &&
    enabled &&
    scope &&
    scope === currentScope &&
    offlineCandidateId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      offlineCandidateId
    )
      ? verifiedHeyaCandidates(
          [
            {
              id: offlineCandidateId,
              url: `heyametadata://image/${offlineCandidateId}?serviceRevision=${status!.revision}`,
              label: "Saved artwork · offline cache",
            },
          ],
          status!.revision
        )
      : []
  const selectedData = reviewed.resolution?.choice ? reviewed.data : data
  const selectedValid = reviewed.resolution?.choice ? !!reviewed.data : valid
  // A saved explicit UUID is a cache-only native target, never a reconstructed
  // online candidate or permission to issue a metadata/image network request.
  const activeData = offlineSaved.length
    ? {
        posters: role === "poster" ? offlineSaved : [],
        backgrounds: role === "background" ? offlineSaved : [],
      }
    : selectedData
  const activeValid = offlineSaved.length > 0 || selectedValid
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
          : verifiedHeyaCandidates(posters, status?.revision ?? "").map(
              (image) => ({
                ...image,
                label: `${image.label ?? "Cover"} reused as background`,
              })
            )
      : []
  const images: ArtworkCandidate[] = verifiedHeyaCandidates(
    raw,
    status?.revision ?? ""
  ).map((image) => ({
    ...image,
    provenance: "HeyaMetadata · verified canonical entity",
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
  }))
  return {
    images,
    pending: reviewed.resolution?.choice ? reviewed.pending : pending,
    revision: status?.revision,
  }
}
