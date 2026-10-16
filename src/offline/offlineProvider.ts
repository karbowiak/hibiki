import type { MusicProvider } from "../providers/types"
import type { OfflineCache } from "./providerCache"
import { offlineKey } from "./providerCache"
import type { TrackPlaybackInfo } from "../providers/types"
import type { LocalAudioPage } from "./audio"
import type { MusicTrack } from "../types/music"

/** Saved browsing is deliberately separate from connected playback/mutations. */
export function createSavedLibraryProvider(
  cacheScope: string,
  cache: OfflineCache,
  owns: () => boolean,
  audio?: {
    track(id: string): Promise<MusicTrack | null>
    playback(id: string): Promise<TrackPlaybackInfo>
    list(
      offset?: number,
      limit?: number,
      cached?: boolean
    ): Promise<LocalAudioPage>
    remove(id: string): Promise<void>
    levels?(id: string): Promise<import("../providers/types").LevelData[]>
  },
  favorites?: MusicProvider["favorites"]
): MusicProvider {
  const session = Object.freeze({})
  const reads = new Set([
    "search",
    "getRecentlyAdded",
    "getLatestReleases",
    "getHubs",
    "getTrack",
    "getAlbum",
    "getArtist",
    "getAlbumTracks",
    "getArtistAlbums",
    "getArtistTracks",
    "getArtistPopularTracks",
    "getArtistSimilar",
    "getRelatedHubs",
    "getPlaylists",
    "getPlaylistItems",
    "getLikedTracks",
    "getLikedAlbums",
    "getLikedArtists",
    "getTags",
    "getItemsByTag",
    "getMixTracks",
    "getSectionStations",
    "getArtistStations",
    "getAllArtists",
    "getAllAlbums",
    "getAllTracks",
    "getArtistPopularTracksInSection",
    "getArtistAlbumsInSection",
  ])
  const blocked = new Set([
    "connect",
    "getStreamUrl",
    "getPlaybackInfo",
    "getTranscodePlaybackInfo",
    "rate",
    "markPlayed",
    "reportProgress",
    "createPlaylist",
    "addToPlaylist",
    "removeFromPlaylist",
    "deletePlaylist",
    "editPlaylist",
    "movePlaylistItem",
    "editMetadata",
    "editAdvancedMetadata",
    "saveArtwork",
    "downloadTracks",
    "createRadioQueue",
    "createSmartShuffleQueue",
    "createPlayQueue",
    "computeSonicPath",
    "getSonicallySimilar",
    "getArtistSonicallySimilar",
    "buildItemUri",
    "buildDirectoryUri",
    "buildPlaylistUri",
    "buildRadioUri",
    "buildTagFilterUri",
  ])
  let retired = false
  const check = () => {
    if (retired || !owns())
      throw new Error("Saved library request was superseded")
  }
  const target = {
    name: "Plex (saved library)",
    cacheScope,
    favorites,
    playbackSession: session,
    isOffline: true,
    capabilities: {
      search: true,
      playlists: true,
      playlistEdit: false,
      metadataEdit: false,
      ratings: false,
      radio: false,
      sonicSimilarity: false,
      djModes: false,
      playQueues: false,
      lyrics: false,
      streamLevels: !!audio?.levels,
      hubs: true,
      stations: false,
      tags: true,
      scrobble: false,
      mixTracks: false,
      browseArtists: true,
      browseAlbums: true,
      browseTracks: true,
      syncArtists: false,
      syncAlbums: false,
      syncTracks: false,
    },
    isConnected: () => false,

    ...(audio
      ? {
          getPlaybackInfo: async (track: MusicTrack) => {
            check()
            const result = await audio.playback(track.id)
            check()
            return result
          },
          getStreamUrl: async (track: MusicTrack) => {
            check()
            const result = await audio.playback(track.id)
            check()
            return result.url
          },
          getLocalAudio: async (offset = 0, limit = 100, cached = false) => {
            check()
            const result = await audio.list(offset, limit, cached)
            check()
            return result
          },
          removeDownload: async (id: string) => {
            check()
            await audio.remove(id)
            check()
          },
          ...(audio.levels
            ? {
                getTrackLevels: async (track: MusicTrack) => {
                  check()
                  const result = await audio.levels!(track.id)
                  check()
                  return result
                },
              }
            : {}),
        }
      : {}),
    disconnect: async () => {
      retired = true
    },
  }
  const functions = new Map<PropertyKey, unknown>()
  return new Proxy(target, {
    get(object, key) {
      if (
        typeof key === "string" &&
        [
          "buildItemUri",
          "buildDirectoryUri",
          "buildPlaylistUri",
          "buildRadioUri",
          "buildTagFilterUri",
          "createPlayQueue",
          "createRadioQueue",
          "createSmartShuffleQueue",
        ].includes(key)
      )
        return undefined
      if (key in object) return Reflect.get(object, key)
      if (functions.has(key)) return functions.get(key)
      if (typeof key !== "string" || (!reads.has(key) && !blocked.has(key)))
        return undefined
      const method =
        typeof key === "string" && reads.has(key)
          ? async (...args: unknown[]) => {
              check()
              if (key === "getTrack" && audio) {
                const track = await audio.track(String(args[0]))
                check()
                if (track) return track
              }
              const snapshot = await cache.get(offlineKey(key, args))
              check()
              if (!snapshot)
                throw new Error(
                  "This page has not been saved for offline browsing. Reconnect to Plex to load it."
                )
              return structuredClone(snapshot.payload)
            }
          : async () => {
              check()
              throw new Error(
                "Reconnect to Plex to use this operation. Complete cached and downloaded tracks can be played from Downloads."
              )
            }
      functions.set(key, method)
      return method
    },
  }) as unknown as MusicProvider
}
