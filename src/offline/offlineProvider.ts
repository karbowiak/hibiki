import type { MusicProvider } from "../providers/types"
import type { OfflineCache } from "./providerCache"
import { offlineKey } from "./providerCache"

/** Saved browsing is deliberately separate from connected playback/mutations. */
export function createSavedLibraryProvider(
  cacheScope: string,
  cache: OfflineCache,
  owns: () => boolean
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
      streamLevels: false,
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
    disconnect: async () => {
      retired = true
    },
  }
  const functions = new Map<PropertyKey, unknown>()
  return new Proxy(target, {
    get(object, key) {
      if (key in object) return Reflect.get(object, key)
      if (functions.has(key)) return functions.get(key)
      if (typeof key !== "string" || (!reads.has(key) && !blocked.has(key)))
        return undefined
      const method =
        typeof key === "string" && reads.has(key)
          ? async (...args: unknown[]) => {
              check()
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
                "Reconnect to Plex to play music or change your library."
              )
            }
      functions.set(key, method)
      return method
    },
  }) as unknown as MusicProvider
}
