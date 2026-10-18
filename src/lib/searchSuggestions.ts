import type { MusicItem } from "../types/music"
import { deduplicateAlbumItems } from "./dedup"

export const searchItemKey = (item: MusicItem) => `${item.providerKey ?? "plex"}:${item.type}:${item.id}`

/** An open query is an append-only presentation. Late provider replies and
 * association updates must not change the action under a pointer/selection. */
export function appendSearchSuggestions(previous: MusicItem[], incoming: MusicItem[], deduplicate = false): MusicItem[] {
  const rows = [...previous], seen = new Set(rows.map(searchItemKey))
  const counts = new Map<string, number>()
  for (const row of rows) {
    const group = `${row.providerKey ?? "plex"}:${row.type}`
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  for (const type of ["artist", "album", "track"] as const) for (const item of incoming) {
    const key = searchItemKey(item), group = `${item.providerKey ?? "plex"}:${item.type}`
    if (item.type !== type || seen.has(key) || (counts.get(group) ?? 0) >= 3) continue
    if (deduplicate && item.type === "album" && deduplicateAlbumItems([...rows, item]).length <= rows.length) continue
    rows.push(item); seen.add(key); counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  return rows
}
