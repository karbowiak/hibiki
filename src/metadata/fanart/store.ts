import { createMetadataStore } from "../../stores/createMetadataStore"
import { useMusicBrainzMetadataStore } from "../musicbrainz/store"
import { useFanartServiceStore } from "../services/store"
import {
  fanartGetArtist,
  type FanartArtist,
  type ProviderArtworkCandidate,
} from "../services/api"
export interface FanartAlbum {
  artist: string
  title: string
  mbid: string
  posters: ProviderArtworkCandidate[]
  backgrounds: ProviderArtworkCandidate[]
  revision: string
}
export const useFanartMetadataStore = createMetadataStore<
  FanartArtist,
  FanartAlbum
>({
  storeName: "fanart-metadata-v1",
  artistTtl: 24 * 60 * 60 * 1000,
  albumTtl: 24 * 60 * 60 * 1000,
  negativeTtl: 60 * 60 * 1000,
  guard: () => {
    const status = useFanartServiceStore.getState().status
    return !!status?.enabled && status.configured
  },
  validateArtist: (data, name) =>
    data.name.trim().toLowerCase() === name.trim().toLowerCase() &&
    data.revision === useFanartServiceStore.getState().status?.revision,
  fetchArtist: async (name) => {
    const status = useFanartServiceStore.getState().status
    if (!status?.enabled || !status.configured) return null
    let artist = await useMusicBrainzMetadataStore.getState().getArtist(name)
    if (artist && artist.wikidata_url === undefined) {
      useMusicBrainzMetadataStore.getState().invalidateArtist(name)
      artist = await useMusicBrainzMetadataStore.getState().getArtist(name)
    }
    if (
      !artist ||
      artist.name.trim().toLowerCase() !== name.trim().toLowerCase()
    )
      return null
    const result = await fanartGetArtist(status.revision, artist.mbid)
    if (useFanartServiceStore.getState().status?.revision !== status.revision)
      return null
    return result &&
      result.mbid === artist.mbid &&
      result.name.trim().toLowerCase() === name.trim().toLowerCase()
      ? result
      : null
  },
  fetchAlbum: async (artist, title) => {
    const status = useFanartServiceStore.getState().status
    if (!status?.enabled || !status.configured) return null
    const match = await useMusicBrainzMetadataStore
      .getState()
      .getAlbum(artist, title)
    if (
      !match?.artist ||
      match.artist.trim().toLowerCase() !== artist.trim().toLowerCase() ||
      match.title.trim().toLowerCase() !== title.trim().toLowerCase()
    )
      return null
    const images = await useFanartMetadataStore.getState().getArtist(artist)
    const album = images?.albums.find((item) => item.mbid === match.mbid)
    if (
      !images ||
      !album ||
      useFanartServiceStore.getState().status?.revision !== status.revision
    )
      return null
    return {
      artist: match.artist,
      title: match.title,
      mbid: match.mbid,
      posters: album.posters,
      backgrounds: [],
      revision: status.revision,
    }
  },
  validateAlbum: (data, artist, title) =>
    data.artist.trim().toLowerCase() === artist.trim().toLowerCase() &&
    data.title.trim().toLowerCase() === title.trim().toLowerCase() &&
    data.revision === useFanartServiceStore.getState().status?.revision,
})
useFanartServiceStore.subscribe((next, old) => {
  if (next.status?.revision !== old.status?.revision)
    useFanartMetadataStore.getState().clearCache()
})
