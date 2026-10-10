export interface TrackStarted {
  playback_id: number
  rating_key: number
  duration_ms: number
}

export interface TrackEnded extends TrackStarted {
  position_ms: number
  listened_ms: number
  reason: "natural" | "skipped" | "stopped" | "error"
}

/** Records survive outgoing overlaps and are consumed once by native identity. */
export class PlaybackJournal<T> {
  private records = new Map<number, { value: T; startedAtUnix: number }>()
  private completed = new Set<number>()
  currentId: number | null = null

  start(event: TrackStarted, value: T, nowMs = Date.now()): boolean {
    if (this.records.has(event.playback_id) || this.completed.has(event.playback_id)) return false
    this.records.set(event.playback_id, { value, startedAtUnix: Math.floor(nowMs / 1000) })
    this.currentId = event.playback_id
    if (this.records.size > 64) this.records.delete(this.records.keys().next().value!)
    return true
  }

  current(): T | null {
    return this.currentId === null ? null : this.records.get(this.currentId)?.value ?? null
  }

  finish(event: TrackEnded): { value: T; startedAtUnix: number; wasCurrent: boolean } | null {
    const record = this.records.get(event.playback_id)
    if (!record) return null
    this.records.delete(event.playback_id)
    this.completed.add(event.playback_id)
    if (this.completed.size > 64) this.completed.delete(this.completed.values().next().value!)
    const wasCurrent = this.currentId === event.playback_id
    if (wasCurrent) this.currentId = null
    return { ...record, wasCurrent }
  }
}

export function listenedEnough(durationMs: number, listenedMs: number): boolean {
  return Number.isFinite(durationMs) && Number.isFinite(listenedMs) && durationMs > 0
    && listenedMs > 0 && listenedMs >= Math.min(durationMs / 2, 240000)
}

export function canScrobble(durationMs: number, listenedMs: number): boolean {
  return durationMs > 30000 && listenedEnough(durationMs, listenedMs)
}

/** An automatic transition advances even if adjacent entries are the same song. */
export function startedQueueIndex(queueIds: string[], currentIndex: number, repeat: 0 | 1 | 2,
  startedId: string, selectedId: string | null): number | null {
  if (selectedId !== null) return selectedId === startedId ? currentIndex : null
  let next = currentIndex + 1
  if (next >= queueIds.length && repeat === 2) next = 0
  return queueIds[next] === startedId ? next : null
}
