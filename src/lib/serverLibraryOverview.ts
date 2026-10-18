import type { MusicProvider } from "../providers/types"
import type { MusicItem, PagedResult } from "../types/music"

export const SERVER_OVERVIEW_LIMIT = 12
export type OverviewKind = "artists" | "albums" | "songs"
export interface ServerOverviewSection {
  kind: OverviewKind
  title: string
  page: PagedResult<MusicItem> | null
  error: string | null
}
/** Five bounded reads at most. No collection warmup, matching scan or detail fanout. */
export async function loadServerOverview(provider: MusicProvider): Promise<ServerOverviewSection[]> {
  return Promise.all((["artists", "albums", "songs"] as const).map(async kind => {
    const method = kind === "artists" ? provider.getAllArtists : kind === "albums" ? provider.getAllAlbums : provider.getAllTracks
    const title = kind === "artists" ? "Explore artists" : kind === "albums" ? "Explore releases" : "Explore songs"
    try {
      if (!method) throw Error("This connection cannot browse this category.")
      const result = await method.call(provider, 0, SERVER_OVERVIEW_LIMIT)
      const type = kind === "artists" ? "artist" : kind === "albums" ? "album" : "track"
      let items = result.items.slice(0, SERVER_OVERVIEW_LIMIT).map(item => ({ ...item, type }) as MusicItem)
      let heading = title
      if (!provider.isOffline && kind !== "artists") {
        try {
          const recent = await provider.getRecentlyAdded(type, SERVER_OVERVIEW_LIMIT)
          if (recent.length) { items = recent.filter(item => item.type === type).slice(0, SERVER_OVERVIEW_LIMIT); heading = kind === "albums" ? "Recently added releases" : "Recently added songs" }
        } catch { /* A failed optional shelf leaves the bounded catalogue page usable. */ }
      }
      return { kind, title: heading, page: { ...result, items }, error: null }
    } catch (error) { return { kind, title, page: null, error: String(error) } }
  }))
}
