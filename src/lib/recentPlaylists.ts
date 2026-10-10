import { useProviderStore } from "../stores/providerStore"
import type { MusicProvider } from "../providers/types"

const MAX_RECENT = 5
interface RecentPlaylistDependencies {
  getProvider(): MusicProvider | null
  getStorage(): Pick<Storage, "getItem" | "setItem"> | undefined
}

export function createRecentPlaylists({ getProvider, getStorage }: RecentPlaylistDependencies) {
  function read(provider = getProvider()): string[] {
    if (!provider?.cacheScope) return []
    try {
      const raw = getStorage()?.getItem(`hibiki-recent-playlists-v2:${provider.cacheScope}`)
      const value: unknown = raw ? JSON.parse(raw) : null
      return Array.isArray(value)
        ? [...new Set(value.filter((id): id is string => typeof id === "string" && !!id))].slice(
            0,
            MAX_RECENT
          )
        : []
    } catch {
      return []
    }
  }
  return {
    read: () => read(),
    record: (id: string, expected = getProvider()) => {
      if (!id || !expected?.cacheScope || getProvider() !== expected) return
      try {
        getStorage()?.setItem(
          `hibiki-recent-playlists-v2:${expected.cacheScope}`,
          JSON.stringify([id, ...read(expected).filter((other) => other !== id)].slice(0, MAX_RECENT))
        )
      } catch {
        /* Recent shortcuts must not turn successful playlist edits into errors. */
      }
    }
  }
}

const recent = createRecentPlaylists({
  getProvider: () => useProviderStore.getState().provider,
  getStorage: () => (typeof localStorage === "undefined" ? undefined : localStorage)
})
export const getRecentPlaylistIds = recent.read
export const recordRecentPlaylist = recent.record
