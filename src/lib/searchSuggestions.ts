import type { MusicItem } from "../types/music"
import { deduplicateAlbumItems } from "./dedup"

export const searchItemSource = (item: MusicItem) => item.providerKey === "ytmusic" ? "ytmusic" : item.providerKey === "hibiki" ? "hibiki" : "plex"
export const searchItemKey = (item: MusicItem) => `${searchItemSource(item)}:${item.type}:${item.id}`

/** Rebuild from the current provider snapshots, never their arrival history.
 * The dropdown preserves interaction identity separately from presentation. */
export function presentSearchSuggestions(incoming: MusicItem[], deduplicate = false): MusicItem[] {
  const rows: MusicItem[] = [], seen = new Set<string>()
  for (const type of ["artist", "album", "track", "playlist"] as const) {
    const groups = (["plex", "ytmusic", "hibiki"] as const).map(source => {
      const group: MusicItem[] = []
      for (const item of incoming) {
        const key = searchItemKey(item)
        if (item.type !== type || searchItemSource(item) !== source || seen.has(key)) continue
        if (deduplicate && type === "album" && deduplicateAlbumItems([...rows, ...group, item]).length <= rows.length + group.length) continue
        group.push(item); seen.add(key)
        if (group.length === 3) break
      }
      return group
    })
    for (let index = 0; index < 3; index++) for (const group of groups) if (group[index]) rows.push(group[index])
  }
  return rows
}
