import { invoke } from "@tauri-apps/api/core"
export interface DiscoveryCapability {
  retryable?: boolean
  available: boolean
  reason: string | null
}
export interface DiscoveryCandidate {
  reference: string
  name: string
  artists: string[]
  disambiguation: string | null
  year: number | null
}
export interface DiscoveryProgress {
  handle: string
  state: string
  candidates: DiscoveryCandidate[]
  canonicalId: string | null
  retryAfter: number
}
export const heyaDiscoveryCapability = (revision: string, scopeId: string) =>
  invoke<DiscoveryCapability>("heya_discovery_capability", {
    revision,
    scopeId,
  })
export const heyaDiscover = (
  revision: string,
  scopeId: string,
  kind: "artist" | "album",
  query: string,
  artist: string,
  _mbid?: string
) =>
  invoke<DiscoveryProgress>("heya_discover", {
    revision,
    scopeId,
    kind,
    query,
    artist,
  })
export const heyaDiscoveryStep = (
  revision: string,
  scopeId: string,
  handle: string,
  candidateRef: string | null = null
) =>
  invoke<DiscoveryProgress>("heya_discovery_step", {
    revision,
    scopeId,
    handle,
    candidateRef,
  })

export const heyaDiscoveryForget = (
  revision: string,
  scopeId: string,
  handle: string
) => invoke<void>("heya_discovery_forget", { revision, scopeId, handle })
