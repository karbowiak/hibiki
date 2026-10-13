import type { MetadataProviderSource } from "./types"

type Connection = { configured: boolean; enabled: boolean } | null
export interface MetadataSourceAvailability {
  lastfmApiKey?: boolean
  fanart?: Connection
  heya?: Connection
  soulsync?: Connection
  theaudiodb?: Connection
}

/** Option visibility follows configuration, not a transient lookup or missing match. */
export function metadataSourceAvailable(
  source: MetadataProviderSource,
  settings: MetadataSourceAvailability
): boolean {
  if (source === "lastfm") return !!settings.lastfmApiKey
  if (source === "fanart" || source === "heya" || source === "soulsync" || source === "theaudiodb") {
    const connection = settings[source]
    return !!connection?.configured && connection.enabled
  }
  return true
}
