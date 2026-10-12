import type { MusicProvider } from "../../providers/types"
import {
  listenBrainzPlaylistAdapter,
  nativeListenBrainzPlaylists,
  providerPlaylistAdapter,
  playlistAttemptJournal,
  type PlaylistAccount,
  type PlaylistAdapter,
  type PlaylistAttemptJournal,
  type PlaylistSnapshot,
} from "../../playlistSync"
export interface PlaylistCopyServices {
  account(): Promise<PlaylistAccount>
  listenBrainz(account: PlaylistAccount): PlaylistAdapter & {
    list(
      offset?: number,
      count?: number
    ): Promise<{ items: PlaylistSnapshot[]; total: number }>
  }
  library(provider: MusicProvider): PlaylistAdapter
  journal: PlaylistAttemptJournal
}
export const playlistCopyServices: PlaylistCopyServices = {
  account: () => nativeListenBrainzPlaylists.account(),
  listenBrainz: (account) => listenBrainzPlaylistAdapter(account),
  // Heuristic recording lookups are not supplied as verified MBIDs.
  library: (provider) => providerPlaylistAdapter(provider),
  journal: playlistAttemptJournal,
}
