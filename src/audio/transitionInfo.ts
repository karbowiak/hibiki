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

export function transitionRows(plan: TransitionInfo | null, hasNext: boolean, repeatOne: boolean): [string, string][] {
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
    rows.push(["Starts at", `${Number((plan.start_time_ms / 1000).toFixed(2))}s`])
  }
  return rows
}
