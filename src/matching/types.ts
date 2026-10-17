export interface MatchingTask {
  kind: "artist" | "album" | "track"
  phase: "scan" | "verify" | "prune" | "complete"
  offset: number
  total: number | null
  started: number
  completed: number | null
  count: number
  requests: number
  bytes: number
  error: string | null
  retryAt: number
}
export interface MatchingStatus {
  paused: boolean
  epoch: number
  revision: number
  tasks: MatchingTask[]
}
export type MatchingAction = "pause" | "resume" | "rebuild" | "clear"
