import type { MusicProvider } from "../providers/types"
import type { PlaylistSnapshot } from "./types"
import { samePlaylistIdentity } from "./types"
import { providerPlaylistAccount } from "./provider"
import { useProviderStore } from "../stores/providerStore"
import { useLibraryStore } from "../stores/libraryStore"
/** Capture the originating connection before a sync write; a replacement library is never invalidated. */
export function createVerifiedPlaylistRefresh(
  provider: MusicProvider,
  current: () => boolean,
  dependencies = {
    getProvider: () => useProviderStore.getState().provider,
    refresh: (id: string, count: number, description?: string) => {
      const remote = (provider as MusicProvider & { __playlistVerified?: (...args: unknown[]) => void }).__playlistVerified
      if (remote) remote(id, count, description)
      else useLibraryStore.getState().onPlaylistSyncVerified(id, count, description)
    },
  }
): (snapshot: PlaylistSnapshot) => void {
  const scope = provider.cacheScope,
    session = provider.playbackSession
  const account = providerPlaylistAccount(provider)
  return (snapshot) => {
    // Presentation failure cannot turn an already confirmed write into an unknown remote outcome.
    try {
      if (
        !current() ||
        dependencies.getProvider() !== provider ||
        provider.cacheScope !== scope ||
        provider.playbackSession !== session ||
        !samePlaylistIdentity(snapshot.account, account) ||
        !snapshot.id ||
        snapshot.items.length > 1000
      )
        return
      dependencies.refresh(
        snapshot.id,
        snapshot.items.length,
        snapshot.description
      )
    } catch {
      /* The retained verified receipt remains the source of truth. */
    }
  }
}
