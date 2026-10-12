import type { MusicHub, MusicItem } from "../types/music"

const matches = (id: string, prefix: string) =>
  id === prefix || id.startsWith(`${prefix}.`)
/** Only cached personalized hubs; never recent additions or generic station shelves. */
export function selectSearchDiscovery(hubs: MusicHub[]) {
  const seen = new Set<string>()
  const take = (items: MusicItem[], limit: number) => {
    const selected: MusicItem[] = []
    for (const item of items) {
      if (!["artist", "album", "track", "playlist"].includes(item.type))
        continue
      const key =
        item.type === "playlist" && (item.providerKey || item.guid)
          ? `playlist:${item.providerKey || item.guid}`
          : item.type === "playlist" && (!item.id || item.id === "0")
            ? `playlist:${JSON.stringify([item.title, item.thumbUrl])}`
            : `${item.type}:${item.id}`
      if (seen.has(key)) continue
      seen.add(key)
      selected.push(item)
      if (selected.length === limit) break
    }
    return selected
  }
  const recent = take(
    hubs
      .filter((h) => matches(h.identifier, "music.recent.played"))
      .flatMap((h) => h.items),
    8
  )
  const mixes = take(
    hubs
      .filter((h) => matches(h.identifier, "music.mixes"))
      .flatMap((h) => h.items)
      .filter((item) => item.type === "playlist"),
    6
  )
  const recommendations: {
    title: string
    identifier: string
    items: MusicItem[]
  }[] = []
  for (const prefix of [
    "music.recent.artist",
    "music.vault",
    "music.recent.genre",
    "music.recent.label",
    "music.popular",
  ]) {
    for (const hub of hubs.filter((h) => matches(h.identifier, prefix))) {
      const items = take(hub.items, 8)
      if (items.length)
        recommendations.push({
          title: hub.title,
          identifier: hub.identifier,
          items,
        })
      if (recommendations.length === 2)
        return { recent, mixes, recommendations }
    }
  }
  return { recent, mixes, recommendations }
}
