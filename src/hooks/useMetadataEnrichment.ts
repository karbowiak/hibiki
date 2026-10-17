/** Track details also display the artist fan count from Deezer. */
import { useState } from "react"
import { useLastfmMetadataStore } from "../metadata/lastfm/store"
import { useDeezerMetadataStore } from "../metadata/deezer/store"
import type { LastfmTrackInfo } from "../metadata/lastfm/api"
import type { DeezerArtistInfo } from "../metadata/deezer/api"
import { useMetadataFetch } from "./useMetadataFetch"

export interface TrackEnrichment {
  lastfm: LastfmTrackInfo | null
  deezer: DeezerArtistInfo | null
}

/**
 * Fetch enrichment metadata for a track from metadata backends that support track info.
 * Also fetches the artist's Deezer data for fan count display in TrackInfoPanel.
 */
export function useTrackEnrichment(
  artistName: string | null,
  trackName: string | null
): TrackEnrichment {
  const getLastfm = useLastfmMetadataStore((s) => s.getTrack)
  const getDeezerArtist = useDeezerMetadataStore((s) => s.getArtist)

  const [lastfm, setLastfm] = useState<LastfmTrackInfo | null>(null)
  const [deezer, setDeezer] = useState<DeezerArtistInfo | null>(null)

  const key = artistName && trackName ? `${artistName}::${trackName}` : null

  useMetadataFetch(
    [
      {
        key,
        fetch: () => getLastfm(artistName!, trackName!),
        setState: setLastfm,
      },
      {
        key: artistName,
        fetch: () => getDeezerArtist(artistName!),
        setState: setDeezer,
      },
    ],
    [key, artistName, getLastfm, getDeezerArtist]
  )

  return { lastfm, deezer }
}
