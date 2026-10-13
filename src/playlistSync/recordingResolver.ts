import type {
  MusicProvider,
  PlaylistRecordingTrack,
  PlaylistRecordingResolution,
} from "../providers/types"
import { useProviderStore } from "../stores/providerStore"
import { recordingMbid } from "./matching"
export interface RecordingResolutionProgress {
  completed: number
  total: number
  trackId: string
  result: PlaylistRecordingResolution
}
export function recordingRowKey(track: PlaylistRecordingTrack): string {
  return JSON.stringify([
    track.id,
    track.title,
    track.artist,
    track.durationMs ?? null,
  ])
}
/** One selected run, one worker; cancellation never admits the remaining rows. */
export async function resolveSelectedPlaylistRecordings(
  provider: MusicProvider,
  tracks: readonly PlaylistRecordingTrack[],
  options: {
    signal?: AbortSignal
    current?: () => MusicProvider | null
    onProgress?: (p: RecordingResolutionProgress) => void
  } = {}
) {
  if (tracks.length > 1000)
    throw Error("Selected playlist exceeds the supported limit")
  const scope = provider.cacheScope,
    session = provider.playbackSession,
    current = options.current ?? (() => useProviderStore.getState().provider)
  const storeState = useProviderStore.getState()
  const usesStoreOwner = storeState.provider === provider
  const owns = () =>
    current() === provider &&
    provider.cacheScope === scope &&
    provider.playbackSession === session &&
    !provider.isOffline &&
    (!usesStoreOwner || useProviderStore.getState() === storeState)
  const inputs = new Map<
    string,
    {
      original: PlaylistRecordingTrack
      copy: PlaylistRecordingTrack
      key: string
    }
  >()
  for (const track of tracks) {
    const old = inputs.get(track.id),
      key = recordingRowKey(track)
    if (old && old.key !== key) {
      throw Error("Selected playlist has conflicting track metadata")
    }
    if (!old) inputs.set(track.id, { original: track, copy: { ...track }, key })
  }
  const results = new Map<
    string,
    { key: string; result: PlaylistRecordingResolution }
  >()
  let completed = 0,
    status: "completed" | "cancelled" | "retired" = "completed"
  for (const [id, input] of inputs) {
    if (!owns()) {
      status = "retired"
      break
    }
    if (options.signal?.aborted) {
      status = "cancelled"
      break
    }
    let result: PlaylistRecordingResolution
    try {
      result = provider.resolvePlaylistRecording
        ? await provider.resolvePlaylistRecording(input.copy)
        : { status: "unavailable", reason: "unsupported-provider" }
    } catch {
      result = { status: "unavailable", reason: "lookup-failed" }
    }
    if (!owns()) {
      status = "retired"
      break
    }
    if (options.signal?.aborted) {
      status = "cancelled"
      break
    }
    if (recordingRowKey(input.original) !== input.key)
      result = { status: "unmatched", reason: "metadata-changed" }
    if (
      result.status === "verified" &&
      (!recordingMbid(result.recordingMbid) ||
        !/^[a-f0-9]{64}$/.test(result.metadataFingerprint) ||
        !["explicit-recording-guid", "release-track-relationship"].includes(
          result.proof
        ))
    )
      result = { status: "unavailable", reason: "invalid-proof" }
    results.set(id, { key: input.key, result })
    completed++
    options.onProgress?.({
      completed,
      total: inputs.size,
      trackId: id,
      result,
    })
  }
  if (status === "retired") results.clear()
  return {
    status,
    completed,
    total: inputs.size,
    results,
    verifiedMbid: (track: PlaylistRecordingTrack): string | null => {
      if (!owns()) return null
      const row = results.get(track.id)
      return row?.key === recordingRowKey(track) &&
        row.result.status === "verified"
        ? row.result.recordingMbid
        : null
    },
  }
}
