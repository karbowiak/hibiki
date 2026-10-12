import { useEffect } from "react"
import { useHeyaArtworkStore } from "../metadata/heya/artworkStore"
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
  allowFetch: boolean
) {
  const status = useHeyaServiceStore((s) => s.status)
  const loadStatus = useHeyaServiceStore((s) => s.load)
  const key =
    kind === "artist"
      ? (artist?.toLowerCase() ?? "")
      : artist && title
        ? `${artist.toLowerCase()}::${title.toLowerCase()}`
        : ""
  const artistEntry = useHeyaArtworkStore((s) =>
    kind === "artist" ? s.artists[key] : undefined
  )
  const albumEntry = useHeyaArtworkStore((s) =>
    kind === "album" ? s.albums[key] : undefined
  )
  const hydrated = useHeyaArtworkStore((s) => s._hasHydrated)
  const pending = useHeyaArtworkStore(
    (s) =>
      !!(kind === "artist" ? s._loadingArtists[key] : s._loadingAlbums[key])
  )
  const getArtist = useHeyaArtworkStore((s) => s.getArtist)
  const getAlbum = useHeyaArtworkStore((s) => s.getAlbum)
  const enabled = !!status?.enabled && status.configured
  const data = artistEntry?.data ?? albumEntry?.data
  const valid =
    enabled &&
    !!data?.id &&
    data.revision === status?.revision &&
    (kind === "artist"
      ? typeof artistEntry?.data?.artist === "string" &&
        artistEntry.data.artist.trim().toLowerCase() ===
          artist?.trim().toLowerCase()
      : !!albumEntry?.data &&
        albumMatches(albumEntry.data, artist ?? "", title ?? ""))
  useEffect(() => {
    if (allowFetch && !status) void loadStatus()
    if (
      !allowFetch ||
      !enabled ||
      !hydrated ||
      !artist ||
      (kind === "album" && !title)
    )
      return
    const entry = kind === "artist" ? artistEntry : albumEntry
    if (
      entry &&
      Date.now() - entry.cachedAt < 30 * 60 * 1000 &&
      (entry.data === null || valid)
    )
      return
    if (kind === "artist") void getArtist(artist).catch(() => {})
    else void getAlbum(artist, title!).catch(() => {})
  }, [
    allowFetch,
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
  const posters = Array.isArray(data?.posters) ? data.posters : []
  const backgrounds = Array.isArray(data?.backgrounds) ? data.backgrounds : []
  const raw =
    valid && data
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
    pending: enabled && (!hydrated || pending),
    revision: status?.revision,
  }
}
