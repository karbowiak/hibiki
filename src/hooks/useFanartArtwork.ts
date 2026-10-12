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
  allowFetch: boolean
) {
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
    if (entry !== undefined && (entry.data === null || valid)) return
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
    pending: enabled && (!hydrated || pending),
    revision: status?.revision,
  }
}
