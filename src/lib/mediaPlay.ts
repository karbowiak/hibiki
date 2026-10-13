import type { MusicItem, MusicTrack } from "../types/music"
import type { MusicProvider } from "../providers/types"
import { useProviderStore } from "../stores/providerStore"
import { useAnnouncerStore } from "../stores/announcerStore"

interface PlayStore {
  playTrack: (
    track: MusicTrack,
    queue?: MusicTrack[],
    title?: string,
    sourceUri?: string | null,
    albumPlaybackId?: string | null
  ) => Promise<void>
  playFromUri: (
    uri: string,
    forceShuffle?: boolean,
    title?: string,
    sourceUri?: string | null,
    albumPlaybackId?: string | null
  ) => Promise<void>
  playPlaylist: (
    playlistId: string,
    totalCount: number,
    title: string,
    sourceUri: string | null
  ) => Promise<void>
  provider: MusicProvider | null
}
interface PlaybackOwnership {
  getProvider: () => MusicProvider | null
  prepare?: () => void
  captureSelection: () => (() => boolean) | Promise<() => boolean>
  reportError: (message: string, current: () => boolean) => void | Promise<void>
}

/** One controller shares intent ordering across every card, not just one callback. */
export function createMediaPlayController(ownership: PlaybackOwnership) {
  let revision = 0
  return function makeOnPlay(
    item: MusicItem,
    store: PlayStore
  ): (() => void) | undefined {
    const { playTrack, playFromUri, playPlaylist, provider } = store
    if (
      !provider ||
      !["track", "album", "artist", "playlist"].includes(item.type)
    )
      return undefined
    ownership.prepare?.()
    return () => {
      if (ownership.getProvider() !== provider) return
      const request = ++revision
      let selected: (() => boolean) | null = null
      const current = () =>
        request === revision &&
        ownership.getProvider() === provider &&
        (!selected || selected())
      const report = (message: string) => {
        if (current())
          void Promise.resolve()
            .then(() => {
              if (current()) return ownership.reportError(message, current)
            })
            .catch(() => {})
      }
      const failure = `Could not play ${item.title}. Please try again.`
      const play = (action: () => Promise<void>) => {
        try {
          const result = action()
          // The player action advances its own selection version. Capture the
          // new version so errors also retire if playback changes elsewhere.
          selected = null
          const fence = ownership.captureSelection()
          if (typeof fence === "function") selected = fence
          else
            void fence
              .then((value) => {
                if (
                  request === revision &&
                  ownership.getProvider() === provider
                )
                  selected = value
              })
              .catch(() => {})
          void Promise.resolve(result).catch(() => report(failure))
        } catch {
          report(failure)
        }
      }
      try {
        if (item.type === "track")
          return play(() => playTrack(item, [item], item.artistName, null))
        if (item.type === "playlist")
          return play(() =>
            playPlaylist(
              item.id,
              item.trackCount,
              item.title,
              `/playlist/${item.id}`
            )
          )
        const uri =
          !provider.isOffline &&
          provider.buildItemUri?.(`/library/metadata/${item.id}`)
        if (uri)
          return play(() =>
            playFromUri(
              uri,
              false,
              item.title,
              `/${item.type}/${item.id}`,
              item.type === "album" ? item.id : undefined
            )
          )
        // Capture before waiting for a provider lookup: any newer selection in
        // the player cancels these unresolved album/artist tracks.
        const selection = ownership.captureSelection()
        void (async () => {
          try {
            selected = await selection
            if (!current()) return
            let tracks =
              item.type === "album"
                ? await provider.getAlbumTracks(item.id)
                : await (provider.isOffline && provider.getArtistTracks
                    ? provider.getArtistTracks(item.id)
                    : provider.getArtistPopularTracks(item.id))
            if (!current()) return
            if (provider.isOffline)
              tracks = tracks.filter(
                (track) =>
                  track.mediaInfo?.localAudio ||
                  track.mediaInfo?.offlineAvailable === true
              )
            if (!tracks.length)
              return report(`No playable tracks were found for ${item.title}.`)
            play(() =>
              playTrack(
                tracks[0],
                tracks,
                item.title,
                `/${item.type}/${item.id}`,
                item.type === "album" ? item.id : undefined
              )
            )
          } catch {
            report(failure)
          }
        })()
      } catch {
        report(failure)
      }
    }
  }
}

// Pages already use the player store, but this shared utility can be imported
// independently. Prepare its existing module before user interaction without
// initializing native playback from a helper import.
let playerModule: typeof import("../stores/playerStore") | null = null
let playerLoading: Promise<typeof import("../stores/playerStore")> | null = null
function loadPlayer() {
  return (playerLoading ??= import("../stores/playerStore").then((module) => {
    playerModule = module
    return module
  }))
}
function selectionFence(module: typeof import("../stores/playerStore")) {
  const version = module.capturePlaybackSelectionVersion()
  return () => module.capturePlaybackSelectionVersion() === version
}
export const makeOnPlay = createMediaPlayController({
  getProvider: () => useProviderStore.getState().provider,
  prepare: () => {
    void loadPlayer().catch(() => {})
  },
  captureSelection: () =>
    playerModule
      ? selectionFence(playerModule)
      : loadPlayer().then(selectionFence),
  reportError: async (message, current) => {
    const module = await loadPlayer()
    if (!current()) return
    module.usePlayerStore.setState({ playerError: message })
    useAnnouncerStore.getState().announce(message, "assertive")
    setTimeout(() => {
      if (current() && module.usePlayerStore.getState().playerError === message)
        module.usePlayerStore.setState({ playerError: null })
    }, 6000)
  },
})
