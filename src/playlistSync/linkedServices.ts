import { verifiedRecordingLookup } from "./verifiedMappings"
import { useLinkedPlaylistStore } from "../stores/linkedPlaylistStore"
import type { MusicProvider } from "../providers/types"
import { useProviderStore } from "../stores/providerStore"
import {
  nativeListenBrainzPlaylists,
  listenBrainzPlaylistAdapter,
} from "./listenbrainz"
import { providerPlaylistAdapter, providerPlaylistAccount } from "./provider"
import { fromJspf } from "./jspf"
import {
  sameAccount,
  type PlaylistAccount,
  type PlaylistSnapshot,
} from "./types"
import { recordingMbid } from "./matching"
import type { LinkedPlaylist } from "./linked"
import type {
  LinkedPlaylistAdapter,
  LinkedSyncServices,
} from "./linkedExecution"
import { linkedPlaylistRepository } from "./linkedJournal"
import { weeklySourceChannels, type WeeklySummary } from "./weekly"
const weeklyFeeds = new Map<
  string,
  {
    expires: number
    request: Promise<{ items: WeeklySummary[]; total: number }>
  }
>()
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
  const mbidFor = verifiedRecordingLookup(link.mappings)
  const libraryReader = providerPlaylistAdapter(provider, {
    verifiedMbid: (track) => mbidFor(track.id),
  })
  const library: LinkedPlaylistAdapter = {
    ...(provider.name.toLowerCase() === "plex"
      ? { preservesDuplicateOccurrences: false }
      : {}),
    account: () => libraryReader.account(),
    read: (id) => libraryReader.read(id),
    ...(provider.describePlaylist
      ? {
          describe: async (
            before: PlaylistSnapshot,
            description: string,
            expected: PlaylistAccount
          ) => {
            if (
              !owns() ||
              !sameAccount(providerPlaylistAccount(provider), expected)
            )
              throw Error("Library account changed")
            if (before.readOnly)
              throw Error("Smart playlists are read-only sync sources")
            await libraryReader.assertWritable(before.id)
            if (!owns()) throw Error("Library account changed")
            const confirmed = await provider.describePlaylist!(
              before.id,
              {
                title: before.title,
                items: before.items.map((item) => ({
                  trackId: item.track.id,
                  occurrenceId: item.occurrenceId,
                })),
              },
              before.description ?? "",
              description
            )
            if (!owns() || confirmed !== description)
              throw Error("Weekly description requires reconciliation")
            return libraryReader.read(before.id)
          },
        }
      : {}),
    mutate: async (before, operation, expected) => {
      if (!owns() || !sameAccount(providerPlaylistAccount(provider), expected))
        throw Error("Library account changed")
      if (before.readOnly)
        throw Error("Smart playlists are read-only sync sources")
      await libraryReader.assertWritable(before.id)
      if (!owns()) throw Error("Library account changed")
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
    latestWeekly: async (family) => {
      if (!owns()) throw Error("Weekly account changed")
      const key = JSON.stringify(lease)
      let feed = weeklyFeeds.get(key)
      if (!feed || feed.expires <= Date.now()) {
        const request = remoteReader.list(0, 100, "createdfor")
        feed = { expires: Date.now() + 60_000, request }
        weeklyFeeds.set(key, feed)
        if (weeklyFeeds.size > 8)
          weeklyFeeds.delete(weeklyFeeds.keys().next().value!)
        void request.catch(() => {
          if (weeklyFeeds.get(key)?.request === request) weeklyFeeds.delete(key)
        })
      }
      const listing = await feed.request
      if (!owns()) throw Error("Weekly account changed")
      return weeklySourceChannels(
        {
          items: listing.items,
          complete: listing.total <= listing.items.length,
        },
        lease
      ).find((channel) => channel.family === family)!
    },
  }
}
