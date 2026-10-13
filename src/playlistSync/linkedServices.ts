import { useLinkedPlaylistStore } from "../stores/linkedPlaylistStore"
import type { MusicProvider } from "../providers/types"
import { useProviderStore } from "../stores/providerStore"
import {
  nativeListenBrainzPlaylists,
  listenBrainzPlaylistAdapter,
} from "./listenbrainz"
import { providerPlaylistAdapter, providerPlaylistAccount } from "./provider"
import { fromJspf } from "./jspf"
import { sameAccount, type PlaylistAccount } from "./types"
import { recordingMbid } from "./matching"
import type { LinkedPlaylist } from "./linked"
import type {
  LinkedPlaylistAdapter,
  LinkedSyncServices,
} from "./linkedExecution"
import { linkedPlaylistRepository } from "./linkedJournal"
export async function linkedSyncServices(
  provider: MusicProvider,
  link: LinkedPlaylist,
  current: () => boolean
): Promise<LinkedSyncServices> {
  if (provider.isOffline || !provider.mutatePlaylistOccurrence)
    throw Error("This connection cannot update linked playlists")
  const session = provider.playbackSession,
    scope = provider.cacheScope
  const owns = () =>
    current() &&
    !useLinkedPlaylistStore.getState().holds[link.id] &&
    useProviderStore.getState().provider === provider &&
    provider.playbackSession === session &&
    provider.cacheScope === scope &&
    !provider.isOffline
  const lease = await nativeListenBrainzPlaylists.account()
  if (!owns()) throw Error("Playlist sync session changed")
  const mbidFor = (id: string) => {
    const values = new Set(
      link.mappings
        .filter((mapping) => mapping.libraryTrack.id === id)
        .map((mapping) => mapping.recordingMbid)
    )
    return values.size === 1 ? [...values][0] : null
  }
  const libraryReader = providerPlaylistAdapter(provider, {
    verifiedMbid: (track) => mbidFor(track.id),
  })
  const library: LinkedPlaylistAdapter = {
    ...(provider.name.toLowerCase() === "plex"
      ? { preservesDuplicateOccurrences: false }
      : {}),
    account: () => libraryReader.account(),
    read: (id) => libraryReader.read(id),
    mutate: async (before, operation, expected) => {
      if (!owns() || !sameAccount(providerPlaylistAccount(provider), expected))
        throw Error("Library account changed")
      await provider.mutatePlaylistOccurrence!(
        before.id,
        {
          title: before.title,
          items: before.items.map((item) => ({
            trackId: item.track.id,
            occurrenceId: item.occurrenceId,
          })),
        },
        operation
      )
      if (!owns()) throw Error("Playlist update requires reconciliation")
      return libraryReader.read(before.id)
    },
  }
  const remoteReader = listenBrainzPlaylistAdapter(lease)
  const remote: LinkedPlaylistAdapter = {
    account: () => nativeListenBrainzPlaylists.account(),
    read: (id) => remoteReader.read(id),
    mutate: async (before, operation, expected) => {
      if (
        !owns() ||
        !nativeListenBrainzPlaylists.mutate ||
        !sameAccount(lease, expected)
      )
        throw Error("ListenBrainz lease changed")
      const mbids = before.items.map((item) => {
        const id = recordingMbid(item.track.recordingMbid)
        if (!id) throw Error("Recording identity unavailable")
        return id
      })
      const result = await nativeListenBrainzPlaylists.mutate(
        expected,
        before.id,
        { title: before.title, mbids },
        operation
      )
      if (!owns()) throw Error("Playlist update requires reconciliation")
      return fromJspf(result, expected)
    },
  }
  return {
    library,
    listenbrainz: remote,
    repository: linkedPlaylistRepository,
    current: owns,
  }
}
