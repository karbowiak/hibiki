import { invoke } from "@tauri-apps/api/core"
import type { MetadataFields, MetadataIdentity } from "../core/types"
import type {
  MetadataServiceStatus,
  ProviderArtworkCandidate,
} from "../services/api"
export interface TheAudioDbItem {
  id: string
  kind: MetadataIdentity["kind"]
  artist: string
  title: string | null
  mbid: string | null
  revision: string
  fields: Partial<MetadataFields>
  posters: ProviderArtworkCandidate[]
  backgrounds: ProviderArtworkCandidate[]
  url: string
}
export type TheAudioDbResult =
  | { status: "ready"; item: TheAudioDbItem }
  | { status: "unavailable" }
  | { status: "ambiguous"; candidates: { id: string; name: string }[] }
export const theAudioDbStatus = (): Promise<MetadataServiceStatus> =>
  invoke("theaudiodb_status")
export const theAudioDbConfigure = (args: {
  revision: string
  apiKey: string | null
  enabled: boolean
  clear: boolean
}): Promise<MetadataServiceStatus> => invoke("theaudiodb_configure", args)
export const theAudioDbLookup = (
  revision: string,
  identity: MetadataIdentity,
  mbid?: string
): Promise<TheAudioDbResult> =>
  invoke("theaudiodb_lookup", {
    revision,
    scopeId: identity.scope,
    identity: {
      kind: identity.kind,
      artist: identity.artist,
      title: identity.title ?? null,
      mbid: mbid ?? null,
    },
  })
