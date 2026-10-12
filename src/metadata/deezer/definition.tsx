import type { MetadataBackendDefinition } from "../types"
import { useDeezerMetadataStore } from "./store"
import { DeezerSettings } from "./settings"

function DeezerIcon({ size = 18 }: { size?: number }) {
  return (
    <svg height={size} width={size} viewBox="0 0 24 24" fill="currentColor" className="text-[#EF5466]">
      <rect x="2" y="14" width="3" height="6" rx="1" />
      <rect x="6.5" y="11" width="3" height="9" rx="1" />
      <rect x="11" y="8" width="3" height="12" rx="1" />
      <rect x="15.5" y="5" width="3" height="15" rx="1" />
      <rect x="20" y="2" width="2" height="18" rx="1" />
    </svg>
  )
}

export const deezerMetadataBackend: MetadataBackendDefinition = {
  id: "deezer",
  name: "Deezer",
  description: "Artist images, album covers, genres, and fan counts via public API.",
  icon: DeezerIcon,
  capabilities: {
    artistBio: false,
    artistImages: true,
    albumCovers: true,
    genres: true,
    tags: false,
    fanCounts: true,
    listenerCounts: false,
    similarArtists: false,
    trackInfo: false,
    scrobble: false,
    lyrics: false,
  },
  SettingsComponent: DeezerSettings,
  useIsEnabled: () => true,
  clearCache: () => useDeezerMetadataStore.getState().clearCache(),
}
