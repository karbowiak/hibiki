import { invoke } from "@tauri-apps/api/core"
export interface SoulSyncStatus {
  revision: string
  baseUrl: string
  configured: boolean
  hasApiKey?: boolean
  enabled: boolean
}
export interface SoulSyncArtist {
  name: string
  summary: string | null
  summaryOrigin?: string | null
  tags?: string[]
  listeners?: number | null
  playCount?: number | null
  thumbUrl: string | null
  genres: string[]
  label: string | null
  mbid: string | null
}
export type SoulSyncLookup =
  | { status: "ready"; artist: SoulSyncArtist }
  | { status: "unavailable" }
  | { status: "ambiguous"; candidates: { id: string; name: string }[] }
export const soulSyncStatus = () => invoke<SoulSyncStatus>("soulsync_status")
export const soulSyncConfigure = (args: {
  revision: string
  baseUrl: string
  apiKey: string | null
  enabled: boolean
  clear: boolean
}) => invoke<SoulSyncStatus>("soulsync_configure", args)
export const soulSyncArtist = (revision: string, artist: string) =>
  invoke<SoulSyncLookup>("soulsync_artist", { revision, artist })
