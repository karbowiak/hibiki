import { invoke } from "@tauri-apps/api/core"
import { fromJspf, playlistId } from "./jspf"
import { recordingMbid } from "./matching"
import { sameAccount } from "./types"
import type { PlaylistAccount, PlaylistAdapter } from "./types"
export interface ListenBrainzPlaylistTransport {
  account(): Promise<PlaylistAccount>
  list(
    expected: PlaylistAccount,
    offset: number,
    count: number
  ): Promise<{
    playlists: unknown[]
    playlist_count: number
    offset: number
    count: number
  }>
  read(expected: PlaylistAccount, id: string): Promise<unknown>
  create(
    expected: PlaylistAccount,
    title: string,
    mbids: readonly string[]
  ): Promise<{ id: string }>
}
export const nativeListenBrainzPlaylists: ListenBrainzPlaylistTransport = {
  account: () => invoke("playlist_sync_listenbrainz_account"),
  list: (expected, offset, count) =>
    invoke("playlist_sync_listenbrainz_list", { expected, offset, count }),
  read: (expected, id) =>
    invoke("playlist_sync_listenbrainz_read", { expected, id }),
  create: (expected, title, mbids) =>
    invoke("playlist_sync_listenbrainz_create", { expected, title, mbids }),
}
/** An adapter stays bound to the exact preview account, including reconnects to the same username. */
export function listenBrainzPlaylistAdapter(
  expected: PlaylistAccount,
  transport = nativeListenBrainzPlaylists
): PlaylistAdapter & {
  list(
    offset?: number,
    count?: number
  ): Promise<{ items: ReturnType<typeof fromJspf>[]; total: number }>
} {
  async function owns() {
    if (!sameAccount(await transport.account(), expected))
      throw Error("ListenBrainz account changed. Preview again.")
  }
  return {
    capabilities: { read: true, createCopy: true, replace: false },
    account: () => transport.account(),
    read: async (id) => {
      await owns()
      const value = await transport.read(expected, playlistId(id))
      await owns()
      return fromJspf(value, expected)
    },
    list: async (offset = 0, count = 50) => {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 100
      )
        throw Error("Invalid playlist page")
      await owns()
      const result = await transport.list(expected, offset, count)
      await owns()
      if (
        !Array.isArray(result.playlists) ||
        result.playlists.length > count ||
        !Number.isSafeInteger(result.playlist_count) ||
        result.playlist_count < 0 ||
        result.offset !== offset
      )
        throw Error("Invalid playlist page response")
      return {
        items: result.playlists.map((value) => fromJspf(value, expected)),
        total: result.playlist_count,
      }
    },
    createCopy: async (title, tracks, account) => {
      if (
        account.service !== expected.service ||
        account.user !== expected.user ||
        account.revision !== expected.revision
      )
        throw Error("Playlist account changed")
      await owns()
      const mbids = tracks.map((track) => {
        const mbid = recordingMbid(track.recordingMbid)
        if (!mbid)
          throw Error("Export requires a recording MBID for every occurrence")
        return mbid
      })
      const created = await transport.create(expected, title, mbids)
      return { id: playlistId(created.id) }
    },
  }
}
