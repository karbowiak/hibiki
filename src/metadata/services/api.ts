import { invoke } from "@tauri-apps/api/core"
export type ConfiguredMetadataService = "fanart" | "heya"
export interface MetadataServiceStatus {
  revision: string
  baseUrl: string
  configured: boolean
  hasApiKey: boolean
  enabled: boolean
}
export const metadataServiceStatus = (
  service: ConfiguredMetadataService
): Promise<MetadataServiceStatus> =>
  invoke("metadata_service_status", { service })
export const metadataServiceConfigure = (
  service: ConfiguredMetadataService,
  args: {
    revision: string
    baseUrl: string
    apiKey: string | null
    enabled: boolean
    clear: boolean
  }
): Promise<MetadataServiceStatus> =>
  invoke("metadata_service_configure", { service, ...args })
export interface ProviderArtworkCandidate {
  id: string
  url: string
  label?: string
}
export interface FanartArtist {
  name: string
  mbid: string
  posters: ProviderArtworkCandidate[]
  backgrounds: ProviderArtworkCandidate[]
  albums: { mbid: string; posters: ProviderArtworkCandidate[] }[]
  revision: string
}
export const fanartGetArtist = (
  revision: string,
  artistMbid: string
): Promise<FanartArtist | null> =>
  invoke("fanart_get_artist", { revision, artistMbid })
