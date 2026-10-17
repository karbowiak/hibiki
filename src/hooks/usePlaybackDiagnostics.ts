import { useEffect, useMemo, useState } from "react"
import { engine } from "../audio/RustAudioEngine"
import {
  transferKiBPerSecond,
  type PlaybackDiagnosticSample,
  type PlaybackDiagnosticsSnapshot,
} from "../audio/playbackDiagnostics"
import { usePlayerStore } from "../stores/playerStore"
import { useProviderStore } from "../stores/providerStore"

interface Observation {
  owner: object | null
  snapshot: PlaybackDiagnosticsSnapshot | null
  samples: PlaybackDiagnosticSample[]
  unavailable: boolean
}
const empty: Observation = {
  owner: null,
  snapshot: null,
  samples: [],
  unavailable: false,
}

/** Mounted only by the open diagnostics tab; never starts an app-wide telemetry loop. */
export function usePlaybackDiagnostics() {
  const trackId = usePlayerStore((s) => s.currentTrack?.id)
  const binding = usePlayerStore((s) => s.playbackFormat)
  const browserAudio = usePlayerStore((s) => s.isInternetRadioActive)
  const provider = useProviderStore((s) => s.provider)
  const session = provider?.playbackSession
  const playbackId = binding?.trackId === trackId ? binding.playbackId : null
  const owner = useMemo(
    () => ({ trackId, playbackId, provider, session, browserAudio }),
    [trackId, playbackId, provider, session, browserAudio]
  )
  const [observation, setObservation] = useState<Observation>(empty)

  useEffect(() => {
    setObservation(empty)
    if (browserAudio || playbackId == null) return
    let cancelled = false
    let busy = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let previous: { at: number; snapshot: PlaybackDiagnosticsSnapshot } | null =
      null
    const current = () =>
      !cancelled &&
      !document.hidden &&
      useProviderStore.getState().provider === provider &&
      provider?.playbackSession === session &&
      usePlayerStore.getState().currentTrack?.id === trackId &&
      usePlayerStore.getState().playbackFormat?.playbackId === playbackId

    async function poll() {
      if (!current() || busy) return
      busy = true
      try {
        const snapshot = await engine.getDiagnostics()
        if (!current() || snapshot?.playbackId !== playbackId) return
        const at = performance.now()
        const sample: PlaybackDiagnosticSample = {
          at,
          bufferSeconds: snapshot.bufferedSeconds,
          transferKiB: transferKiBPerSecond(previous, snapshot, at),
          blockUs:
            previous &&
            snapshot.blocks > previous.snapshot.blocks &&
            snapshot.state === "playing"
              ? snapshot.blockUs
              : null,
        }
        previous = { at, snapshot }
        setObservation((old) => ({
          owner,
          snapshot,
          unavailable: false,
          samples: [
            ...old.samples.filter((point) => at - point.at <= 30_000),
            sample,
          ].slice(-60),
        }))
      } catch {
        if (current())
          setObservation((old) => ({ ...old, owner, unavailable: true }))
      } finally {
        busy = false
        if (current()) timer = setTimeout(poll, 500)
      }
    }
    function visibilityChanged() {
      clearTimeout(timer)
      previous = null
      if (!document.hidden) void poll()
    }
    document.addEventListener("visibilitychange", visibilityChanged)
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", visibilityChanged)
    }
  }, [owner])

  // Do not show the preceding track's sample during an effect transition.
  const valid =
    observation.owner === owner &&
    observation.snapshot?.playbackId === playbackId &&
    binding?.trackId === trackId &&
    !browserAudio
  return {
    ...(valid
      ? observation
      : {
          ...empty,
          unavailable: observation.owner === owner && observation.unavailable,
        }),
    browserAudio,
    playbackId,
  }
}
