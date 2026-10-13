import type { MusicProvider } from "../providers/types"
import type { MusicTrack } from "../types/music"
import { useProviderStore } from "../stores/providerStore"
import { MAX_PLAYLIST_ITEMS } from "./planner"
import { recordingMbid } from "./matching"
import {
  sameAccount,
  type PlaylistAccount,
  type PlaylistAdapter,
  type PlaylistTrack,
} from "./types"
export function providerPlaylistAccount(
  provider: MusicProvider
): PlaylistAccount {
  const scope = provider.cacheScope
  if (!scope)
    throw Error(
      "Playlist copying requires an account-scoped library connection"
    )
  // This is durable account/server/library identity. Runtime connection ownership
  // is checked separately by the adapter, so receipts remain reviewable after restart.
  return {
    service: `library:${provider.name}`,
    user: scope,
    revision: "scope-v1",
  }
}
export function playlistTrackFromMusic(
  track: MusicTrack,
  verifiedMbid?: string | null
): PlaylistTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artistName,
    album: track.albumName,
    durationMs: track.duration,
    recordingMbid: recordingMbid(verifiedMbid),
  }
}
export function providerPlaylistAdapter(
  provider: MusicProvider,
  options: {
    current?: () => MusicProvider | null
    verifiedMbid?: (track: MusicTrack) => string | null
  } = {}
): PlaylistAdapter {
  const expected = providerPlaylistAccount(provider),
    session = provider.playbackSession,
    current = options.current ?? (() => useProviderStore.getState().provider)
  function owns() {
    if (
      current() !== provider ||
      provider.playbackSession !== session ||
      !sameAccount(providerPlaylistAccount(provider), expected)
    )
      throw Error("Library account changed. Preview again.")
  }
  return {
    capabilities: {
      read: provider.capabilities.playlists,
      createCopy: provider.capabilities.playlists,
      replace: false,
      ...(provider.name.toLowerCase() === "plex"
        ? { preservesDuplicateCopies: false }
        : {}),
    },
    account: async () => {
      owns()
      return expected
    },
    read: async (id) => {
      owns()
      const playlists = await provider.getPlaylists()
      owns()
      const metadata = playlists.find((playlist) => playlist.id === id)
      if (!metadata) throw Error("Source playlist is no longer available")
      const items = [],
        occurrenceIds = new Set<string>()
      let total: number | undefined
      while (total === undefined || items.length < total) {
        const offset = items.length,
          page = await provider.getPlaylistItems(id, offset, 100)
        owns()
        if (
          !Number.isSafeInteger(page.total) ||
          page.total < 0 ||
          page.total > MAX_PLAYLIST_ITEMS ||
          (page.offset !== undefined && page.offset !== offset) ||
          page.items.length > 100
        )
          throw Error("Invalid or oversized playlist page")
        if (total !== undefined && total !== page.total)
          throw Error("Playlist changed while reading. Preview again.")
        total = page.total
        if (
          items.length + page.items.length > total ||
          (!page.items.length && items.length < total)
        )
          throw Error("Incomplete playlist page")
        for (const track of page.items) {
          const occurrenceId = track.playlistItemId || `${id}:${items.length}`
          if (occurrenceIds.has(occurrenceId))
            throw Error("Repeated playlist page or occurrence identity")
          occurrenceIds.add(occurrenceId)
          items.push({
            occurrenceId,
            track: playlistTrackFromMusic(track, options.verifiedMbid?.(track)),
          })
        }
      }
      return {
        account: expected,
        id,
        title: metadata.title,
        description: metadata.summary ?? "",
        items,
      }
    },
    createCopy: async (title, tracks, account) => {
      owns()
      if (
        !sameAccount(account, expected) ||
        !provider.capabilities.playlists ||
        tracks.length > MAX_PLAYLIST_ITEMS
      )
        throw Error("Destination account or capability changed")
      // Preserve every occurrence, including repeated IDs. Verify the server's returned order afterward.
      const created = await provider.createPlaylist(
        title,
        tracks.map((track) => track.id)
      )
      return { id: created.id }
    },
  }
}
