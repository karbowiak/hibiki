import { invoke } from "@tauri-apps/api/core"
import type {
  PlexRequestContext,
  PlexTransport,
} from "../backends/plex/scopedApi"
import type { FavoriteRecording, FavoritePage, FavoritesNative } from "./types"
import type { PlaylistAccount } from "../playlistSync/types"
import type { Track } from "../backends/plex/types"
import type { MusicTrack } from "../types/music"
export function createFavoritesNative(
  context: PlexRequestContext,
  sectionId: number,
  transport: PlexTransport = invoke,
  current = () => true,
  mapTracks?: (rows: Track[]) => Promise<MusicTrack[]>
): FavoritesNative {
  const owned = { ...context }
  const call = async <T>(
    command: string,
    args: Record<string, unknown> = {}
  ): Promise<T> => {
    if (!current()) throw Error("Favorite library changed")
    const result = await transport<T>(command, { ...args, context: owned })
    if (!current()) throw Error("Favorite library changed")
    return result
  }
  return {
    cachedTracks: mapTracks
      ? async (ids) =>
          mapTracks(
            await call<Track[]>("favorites_tracks", { ids: ids.map(Number) })
          )
      : undefined,
    load: () => call("favorites_load"),
    page: (offset, limit) => call("favorites_page", { offset, limit }),
    save: (expected, metadata, rows) =>
      call("favorites_save", { expected, metadata, rows }),
    plexRead: (id) =>
      call("favorites_plex_read", { sectionId, playlistId: Number(id) }),
    plexMutate: (id, beforeHash, operation) =>
      call("favorites_plex_mutate", {
        sectionId,
        playlistId: Number(id),
        beforeHash,
        operation,
      }),
  }
}
export const favoritesRemote = {
  account: (service: string): Promise<PlaylistAccount> =>
    invoke("favorites_remote_account", { service }),
  page: (expected: PlaylistAccount, offset: number): Promise<FavoritePage> =>
    invoke("favorites_remote_page", { expected, offset }),
  peek: (
    expected: PlaylistAccount,
    record: FavoriteRecording
  ): Promise<boolean> => invoke("favorites_remote_peek", { expected, record }),
  set: (
    expected: PlaylistAccount,
    record: FavoriteRecording,
    liked: boolean,
    before: boolean
  ): Promise<boolean> =>
    invoke("favorites_remote_set", { expected, record, liked, before }),
}
