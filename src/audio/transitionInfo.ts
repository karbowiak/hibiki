import { formatMs } from "../lib/formatters"

/** The transition computed by the native engine, including its fallback reason. */
export interface TransitionInfo {
  outgoing_rating_key: number
  incoming_rating_key: number
  mode: "mixRamp" | "timed" | "gapless"
  reason: "missingRamps" | "noUsableCrossing" | "sameAlbum" | "crossfadeDisabled" | "directAudio" | "noOverlap" | null
  start_time_ms: number
  duration_ms: number
}

const reasons: Record<NonNullable<TransitionInfo["reason"]>, string> = {
  missingRamps: "Loudness ramps unavailable",
  noUsableCrossing: "No usable loudness crossing",
  sameAlbum: "Consecutive album tracks",
  crossfadeDisabled: "Crossfade disabled",
  directAudio: "Direct audio",
  noOverlap: "No overlap needed",
}

export function transitionRows(plan: TransitionInfo | null, hasNext: boolean, repeatOne: boolean, trackDurationMs?: number): [string, string][] {
  if (repeatOne) return [["Transition", "Repeat current track"]]
  if (!hasNext) return [["Transition", "End of queue"]]
  if (!plan) return [["Transition", "Preparing next track…"]]
  const rows: [string, string][] = [["Transition", {
    mixRamp: "MixRamp overlap",
    timed: "Timed crossfade",
    gapless: "Gapless",
  }[plan.mode]]]
  if (plan.reason) rows.push(["Reason", reasons[plan.reason]])
  if (plan.mode !== "gapless") {
    rows.push(["Overlap", `${Number((plan.duration_ms / 1000).toFixed(2))}s`])
    const start = plan.start_time_ms
    if (Number.isFinite(start) && start >= 0 && typeof trackDurationMs === "number" && Number.isFinite(trackDurationMs) && trackDurationMs > 0 && start <= trackDurationMs) {
      const remainingMs = trackDurationMs - start
      const seconds = Math.round(remainingMs / 1000)
      const beforeEnd = remainingMs < 1000
        ? `${Number((remainingMs / 1000).toFixed(2))}s`
        : seconds < 60
          ? `${seconds}s`
          : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      rows.push(["Starts", `${beforeEnd} before end`])
    } else {
      rows.push(["Starts at", Number.isFinite(start) && start >= 0 ? formatMs(start) : "Unknown"])
    }
  }
  return rows
}
