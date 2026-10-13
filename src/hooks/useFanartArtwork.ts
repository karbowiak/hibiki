import type { MetadataIdentity } from "../metadata/core/types"
import { useReviewedArtwork } from "./useReviewedArtwork"
import { useProviderStore } from "../stores/providerStore"
import { useEffect } from "react"
import { useFanartMetadataStore } from "../metadata/fanart/store"
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
  const key =
    kind === "artist"
      ? (artist?.toLowerCase() ?? "")
      : artist && title
        ? `${artist.toLowerCase()}::${title.toLowerCase()}`
        : ""
  const artistEntry = useFanartMetadataStore((s) =>
    kind === "artist" ? s.artists[key] : undefined
  )
  const albumEntry = useFanartMetadataStore((s) =>
    kind === "album" ? s.albums[key] : undefined
  )
  const hydrated = useFanartMetadataStore((s) => s._hasHydrated)
  const pending = useFanartMetadataStore(
    (s) =>
      !!(kind === "artist" ? s._loadingArtists[key] : s._loadingAlbums[key])
  )
  const getArtist = useFanartMetadataStore((s) => s.getArtist)
  const getAlbum = useFanartMetadataStore((s) => s.getAlbum)
  const enabled = !!status?.enabled && status.configured
  const data = artistEntry?.data ?? albumEntry?.data
  const valid =
    enabled &&
    !!data?.mbid &&
    data.revision === status?.revision &&
    (kind === "artist"
      ? typeof artistEntry?.data?.name === "string" &&
        artistEntry.data.name.trim().toLowerCase() ===
          artist?.trim().toLowerCase()
      : !!albumEntry?.data &&
        albumMatches(albumEntry.data, artist ?? "", title ?? ""))
  useEffect(() => {
    if ((allowFetch || offline) && !status) void loadStatus()
    if (
      !!reviewed.resolution?.choice ||
      !allowFetch ||
      offline ||
      !enabled ||
      !hydrated ||
      !artist ||
      (kind === "album" && !title)
    )
      return
    const entry = kind === "artist" ? artistEntry : albumEntry
    if (entry !== undefined && (entry.data === null || valid)) return
    if (kind === "artist") void getArtist(artist).catch(() => {})
    else void getAlbum(artist, title!).catch(() => {})
  }, [
    allowFetch,
    reviewed.resolution?.lease,
    offline,
    status,
    enabled,
    hydrated,
    artist,
    title,
    kind,
    artistEntry?.data,
    albumEntry?.data,
    valid,
    getArtist,
    getAlbum,
    loadStatus,
  ])
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
    pending: reviewed.resolution?.choice
      ? reviewed.pending
      : enabled && (!hydrated || pending),
    revision: status?.revision,
  }
}
