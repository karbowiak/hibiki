import { invoke } from "@tauri-apps/api/core"
import { createMetadataStore } from "../../stores/createMetadataStore"
import { useMusicBrainzMetadataStore } from "../musicbrainz/store"
export interface CoverArtArchiveAlbum {
  artist: string
  title: string
  mbid: string
  cover_url: string
}
/** No name-based CAA search: only an unambiguous returned MusicBrainz credit. */
export const useCoverArtArchiveMetadataStore = createMetadataStore<
  null,
  CoverArtArchiveAlbum
>({
  storeName: "coverartarchive-metadata-v1",
  albumTtl: 48 * 60 * 60 * 1000,
  negativeTtl: 24 * 60 * 60 * 1000,
  fetchArtist: async () => null,
  fetchAlbum: async (artist, title) => {
    const match = await useMusicBrainzMetadataStore
      .getState()
      .getAlbum(artist, title)
    if (
      !match?.artist ||
      match.artist.trim().toLowerCase() !== artist.trim().toLowerCase() ||
      match.title.trim().toLowerCase() !== title.trim().toLowerCase()
    )
      return null
    const art = await invoke<{ cover_url: string } | null>(
      "coverartarchive_get_album",
      { releaseGroupMbid: match.mbid }
    )
    return art
      ? {
          artist: match.artist,
          title: match.title,
          mbid: match.mbid,
          cover_url: art.cover_url,
        }
      : null
  },
  validateAlbum: (data, artist, title) =>
    data.artist.trim().toLowerCase() === artist.trim().toLowerCase() &&
    data.title.trim().toLowerCase() === title.trim().toLowerCase(),
})
