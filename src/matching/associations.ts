import type { MusicItem } from "../types/music"
import { albumMatchingSource, artistMatchingSource, trackMatchingSource } from "./sources"
import type { MatchingResolution, MatchingSource } from "./resolverTypes"

/** A view-local projection of native proofs, never a second identity cache.
 * Missing/ambiguous identities remain separate; partial indexes cannot erase YTM. */
export async function associateMusicItems(items: MusicItem[], current: () => boolean,
  lookup: (source: MatchingSource) => Promise<MatchingResolution | null> = async source => (await import("./service")).queryIndexedMusic(source)) {
  const found = new Map<string, string | null>()
  const inputs = [...new Map(items.filter(item => item.id.startsWith("ytmusic:") && item.type !== "playlist").map(item => [item.id, item])).values()].slice(0, 256)
  for (let offset = 0; offset < inputs.length && current(); offset += 16) {
    await Promise.all(inputs.slice(offset, offset + 16).map(async item => {
      const source = item.type === "artist" ? artistMatchingSource(item) : item.type === "album" ? albumMatchingSource(item) : item.type === "track" ? trackMatchingSource(item) : null
      if (!source) return
      const result = await lookup(source).catch(() => null)
      if (result && current()) found.set(item.id, result.status === "matched" && result.selected ? String(result.selected) : null)
    }))
  }
  return current() ? found : new Map<string, string | null>()
}
