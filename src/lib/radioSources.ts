import type { MusicProvider } from "../providers/types"
import type { MusicTrack } from "../types/music"
import { filterPlayable } from "../audio/queueExpansion"
import { isYoutubeMusicId } from "../backends/ytmusic/tracks"
import { browseYoutubeMusic, useYoutubeMusicDiscoveryStore, youtubeMusicItemTrack } from "../backends/ytmusic/discovery"
import { sameRecording } from "./musicMatching"
import { MusicRadioSession, type MusicRadioMode, type MusicRadioSeedType, type RadioSource } from "./musicRadio"

export async function createMusicRadio({ mode, provider, seedId, seedType, track, degrees, current }: {
  mode: MusicRadioMode; provider: MusicProvider | null; seedId: string; seedType: MusicRadioSeedType;
  track?: MusicTrack | null; degrees: () => number; current: () => boolean
}) {
  const session = provider?.playbackSession, scope = provider?.cacheScope
  const connection = useYoutubeMusicDiscoveryStore.getState()
  const providerCurrent = () => current() && provider?.playbackSession === session && provider?.cacheScope === scope
  const youtubeCurrent = () => providerCurrent() && useYoutubeMusicDiscoveryStore.getState().connected &&
    useYoutubeMusicDiscoveryStore.getState().revision === connection.revision
  const remoteSeed = isYoutubeMusicId(seedId)
  let effectiveMode = mode
  let plexSeed = remoteSeed ? null : seedId
  let youtubeSeed = remoteSeed ? seedId.slice(8) : null
  if (mode !== "ytmusic" && (!provider?.createRadioQueue || provider.isOffline)) throw Error("Connect to Plex to start Plex radio.")
  if (mode !== "plex" && !connection.connected) throw Error("Connect YouTube Music to start YTM radio.")
  if (mode !== "plex" && seedType !== "track") throw Error("Choose a song to start YTM or mixed radio.")
  if ((mode === "mixed" || (mode === "plex" && remoteSeed) || (mode === "ytmusic" && !remoteSeed)) && !track)
    throw Error("Choose a song to match between Plex and YouTube Music.")

  await Promise.all([
    (async () => {
      if (mode === "ytmusic" || plexSeed || !track || !provider) return
      const results = await provider.search(track.title, "track")
      if (!providerCurrent()) throw Error("Music library changed.")
      plexSeed = results.find(item => item.type === "track" && sameRecording(track, item))?.id ?? null
      if (!plexSeed) {
        if (mode === "mixed") effectiveMode = "ytmusic"
        else throw Error("This song has no matching Plex recording to seed its radio.")
      }
    })(),
    (async () => {
      if (mode === "plex" || youtubeSeed || !track) return
      const page = await browseYoutubeMusic({ browseId: "hibiki_song_search", params: `${track.artistName} ${track.title}` })
      if (!youtubeCurrent()) throw Error("YouTube Music connection changed.")
      youtubeSeed = page.items.filter(item => item.kind === "song").map(youtubeMusicItemTrack)
        .find(item => sameRecording(track, item))?.id.slice(8) ?? null
      if (!youtubeSeed) {
        if (mode === "mixed") effectiveMode = "plex"
        else throw Error("This song has no matching YTM recording to seed its radio.")
      }
    })(),
  ])
  if (!providerCurrent()) throw Error("Music library changed.")
  let queueId: number | null = null
  let first: MusicTrack | null = track ?? null
  const sources: Partial<Record<"plex" | "ytmusic", RadioSource>> = {}
  if (effectiveMode !== "ytmusic" && plexSeed && provider?.createRadioQueue) {
    const id = plexSeed
    sources.plex = { load: async () => {
      if (!providerCurrent()) throw Error("Plex connection changed.")
      const result = await provider.createRadioQueue!(id, remoteSeed ? "track" : seedType, degrees())
      if (!providerCurrent()) throw Error("Plex connection changed.")
      queueId = result.queueId
      const tracks = filterPlayable(result.tracks)
      if (!first) first = tracks.find(item => item.id === seedId) ?? tracks[0] ?? null
      return tracks
    } }
  }
  if (effectiveMode !== "plex" && youtubeSeed) {
    const destination = { browseId: `VLRDAMVM${youtubeSeed}` }
    let cursor: string | null = null, started = false
    const seen = new Set<string>()
    sources.ytmusic = { load: async () => {
      if (!youtubeCurrent()) throw Error("YouTube Music connection changed.")
      const next = started ? cursor : null
      const page = await browseYoutubeMusic(destination, next, started && !cursor)
      if (!youtubeCurrent()) throw Error("YouTube Music connection changed.")
      started = true
      cursor = page.continuation && !seen.has(page.continuation) ? page.continuation : null
      if (cursor) seen.add(cursor)
      return page.items.filter(item => item.kind === "song").map(youtubeMusicItemTrack)
    } }
  }
  const radio = new MusicRadioSession(effectiveMode, sources, effectiveMode === "plex" ? providerCurrent : youtubeCurrent)
  return { radio, get queueId() { return queueId }, get seed() { return first } }
}
