import type {
  MusicProvider,
  TrackPlaybackInfo,
  LevelData,
} from "../providers/types"
import type { MusicTrack } from "../types/music"
import { selectReplayGain } from "./playbackContext"
import { evictMap } from "../stores/cacheUtils"

interface Session {
  identity: unknown
  scope: string | null | undefined
  full: Map<string, MusicTrack>
  fullRequests: Map<string, Promise<MusicTrack>>
  info: Map<string, TrackPlaybackInfo>
  infoRequests: Map<string, Promise<TrackPlaybackInfo>>
}

function variantKey(track: MusicTrack): string {
  const media = (
    track._providerData as
      | { media?: { id?: number; parts?: { id?: number; key?: string }[] }[] }
      | undefined
  )?.media
  return JSON.stringify([
    track.id,
    track.codec ?? null,
    track.mediaInfo?.audioStreamId ?? null,
    media?.map((item) => [
      item.id ?? null,
      item.parts?.map((part) => [part.id ?? null, part.key ?? null]),
    ]) ?? null,
  ])
}

/** Runtime metadata is isolated even when providers reuse numeric track IDs. */
export class PlaybackMetadata {
  private sessions = new WeakMap<MusicProvider, Session>()
  private session(provider: MusicProvider) {
    let session = this.sessions.get(provider)
    if (
      !session ||
      session.scope !== provider.cacheScope ||
      session.identity !== provider.playbackSession
    ) {
      session = {
        identity: provider.playbackSession,
        scope: provider.cacheScope,
        full: new Map(),
        fullRequests: new Map(),
        info: new Map(),
        infoRequests: new Map(),
      }
      this.sessions.set(provider, session)
    }
    return session
  }

  fullTrack(provider: MusicProvider, id: string): Promise<MusicTrack> {
    const session = this.session(provider)
    const cached = session.full.get(id)
    if (cached) return Promise.resolve(cached)
    const pending = session.fullRequests.get(id)
    if (pending) return pending
    const request = (async () => {
      const track = await provider.getTrack(id)
      if (track.id !== id) throw new Error("Server returned a different track")
      if (this.session(provider) !== session)
        throw new Error("Playback metadata scope changed")
      session.full.set(id, track)
      evictMap(session.full, 500)
      return track
    })().finally(() => {
      if (session.fullRequests.get(id) === request)
        session.fullRequests.delete(id)
    })
    session.fullRequests.set(id, request)
    return request
  }

  async gain(
    provider: MusicProvider,
    track: MusicTrack,
    albumPlaybackId: string | null
  ): Promise<number | null> {
    const finite = (value: number | null | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? value : null
    let gain = finite(track.gain),
      albumGain = finite(track.albumGain)
    if (gain === null && albumGain === null) {
      if (track.mediaInfo?.localAudio) return null
      try {
        const full = await this.fullTrack(provider, track.id)
        gain = finite(full.gain)
        albumGain = finite(full.albumGain)
      } catch {
        return null
      }
    }
    return selectReplayGain(
      {
        albumId: track.albumId,
        _albumGroupIds: track._albumGroupIds,
        gain,
        albumGain,
      },
      albumPlaybackId
    )
  }

  async streamId(
    provider: MusicProvider,
    track: MusicTrack
  ): Promise<number | null> {
    if (track.mediaInfo?.localAudio) return null
    const valid = (value: number | null | undefined) =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : null
    const inline = valid(track.mediaInfo?.audioStreamId)
    if (inline !== null) return inline
    try {
      return valid(
        (await this.fullTrack(provider, track.id)).mediaInfo?.audioStreamId
      )
    } catch {
      return null
    }
  }

  async levels(
    provider: MusicProvider,
    track: MusicTrack
  ): Promise<LevelData[]> {
    const session = this.session(provider)
    let levels: LevelData[]
    if (provider.getTrackLevels) levels = await provider.getTrackLevels(track)
    else {
      const streamId = await this.streamId(provider, track)
      levels =
        streamId !== null && provider.getStreamLevels
          ? await provider.getStreamLevels(streamId, 128)
          : []
    }
    if (this.session(provider) !== session)
      throw new Error("Playback metadata scope changed")
    return levels
  }

  playbackInfo(
    provider: MusicProvider,
    track: MusicTrack
  ): Promise<TrackPlaybackInfo> {
    const session = this.session(provider)
    const key = variantKey(track)
    const cached = session.info.get(key)
    if (cached) return Promise.resolve(cached)
    const pending = session.infoRequests.get(key)
    if (pending) return pending
    const request = (async () => {
      const candidate =
        session.full.get(track.id) ??
        (await session.fullRequests.get(track.id)?.catch(() => undefined))
      const requestedStream = track.mediaInfo?.audioStreamId
      const full =
        candidate &&
        (requestedStream == null ||
          requestedStream === candidate.mediaInfo?.audioStreamId) &&
        (!track.codec || !candidate.codec || track.codec === candidate.codec)
          ? candidate
          : undefined
      if (this.session(provider) !== session)
        throw new Error("Playback metadata scope changed")
      const info = await provider.getPlaybackInfo(full ?? track)
      if (this.session(provider) !== session)
        throw new Error("Playback metadata scope changed")
      // A bounded Plex analysis request may finish on the server after its
      // first preparation attempt. Keep missing gain eligible for refresh when
      // this prefetched track actually reaches the player/preload deck.
      if (!(
        info.plexContext &&
        info.trackGain === null &&
        info.albumGain === null
      )) {
        session.info.set(key, info)
        evictMap(session.info, 500)
      }
      return info
    })().finally(() => {
      if (session.infoRequests.get(key) === request)
        session.infoRequests.delete(key)
    })
    session.infoRequests.set(key, request)
    return request
  }
}
