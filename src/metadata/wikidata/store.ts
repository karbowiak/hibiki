import { invoke } from "@tauri-apps/api/core"
import { createMetadataStore } from "../../stores/createMetadataStore"
import { useMusicBrainzMetadataStore } from "../musicbrainz/store"
export interface WikidataArtist {
  name: string
  qid: string
  description: string | null
  wikipedia_url: string | null
}
export function verifiedWikidataQid(
  value: string | null | undefined
): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.wikidata.org" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null
    return /^\/wiki\/(Q[1-9][0-9]{0,18})$/.exec(url.pathname)?.[1] ?? null
  } catch {
    return null
  }
}
export const useWikidataMetadataStore = createMetadataStore<
  WikidataArtist,
  null
>({
  storeName: "wikidata-metadata-v1",
  artistTtl: 24 * 60 * 60 * 1000,
  negativeTtl: 60 * 60 * 1000,
  fetchArtist: async (name) => {
    let artist = await useMusicBrainzMetadataStore.getState().getArtist(name)
    // Upgrade just this old cached artist: older responses did not contain the
    // relation field and their search did not reject homonyms.
    if (artist && artist.wikidata_url === undefined) {
      useMusicBrainzMetadataStore.getState().invalidateArtist(name)
      artist = await useMusicBrainzMetadataStore.getState().getArtist(name)
    }
    if (
      !artist ||
      artist.name.trim().toLowerCase() !== name.trim().toLowerCase()
    )
      return null
    const qid = verifiedWikidataQid(artist.wikidata_url)
    if (!qid) return null
    const result = await invoke<Omit<WikidataArtist, "name"> | null>(
      "wikidata_get_artist",
      { qid, artistMbid: artist.mbid }
    )
    return result ? { ...result, name: artist.name } : null
  },
  fetchAlbum: async () => null,
})
