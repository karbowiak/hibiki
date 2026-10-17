import type { MusicProvider } from "../providers/types"
import {
  nativeListenBrainzPlaylists,
  listenBrainzPlaylistAdapter,
  type ListenBrainzPlaylistSummary,
} from "./listenbrainz"
import { providerPlaylistAdapter } from "./provider"
import { linkedSyncServices } from "./linkedServices"
import {
  linkedPlaylistRepository,
  type LinkedPlaylistRepository,
} from "./linkedJournal"
import { syncCreationJournal, type SyncCreationJournal } from "./creation"
import type { LinkedSyncServices } from "./linkedExecution"
import type { LinkedPlaylist } from "./linked"
import type {
  PlaylistAccount,
  PlaylistAdapter,
  PlaylistSnapshot,
} from "./types"
import { verifiedRecordingLookup } from "./verifiedMappings"

export interface LinkedPlaylistManagerServices {
  creationJournal?: SyncCreationJournal
  account(): Promise<PlaylistAccount>
  library(provider: MusicProvider, link?: LinkedPlaylist): PlaylistAdapter
  remote(account: PlaylistAccount): PlaylistAdapter & {
    list(
      offset?: number,
      count?: number
    ): Promise<{ items: PlaylistSnapshot[]; total: number }>
    listAll?(): Promise<{
      items: ListenBrainzPlaylistSummary[]
      total: number
      complete: boolean
      truncated: boolean
    }>
  }
  sync(
    provider: MusicProvider,
    link: LinkedPlaylist,
    current: () => boolean
  ): Promise<LinkedSyncServices>
  repository: LinkedPlaylistRepository
}
export const linkedPlaylistManagerServices: LinkedPlaylistManagerServices = {
  account: () => nativeListenBrainzPlaylists.account(),
  library: (provider, link) => {
    const lookup = verifiedRecordingLookup(link?.mappings)
    return providerPlaylistAdapter(provider, {
      verifiedMbid: (track) => lookup(track.id),
    })
  },
  remote: (account) => listenBrainzPlaylistAdapter(account),
  sync: linkedSyncServices,
  repository: linkedPlaylistRepository,
  creationJournal: syncCreationJournal,
}
