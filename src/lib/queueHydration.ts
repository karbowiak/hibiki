import type { MusicTrack } from "../types/music"

export interface QueueLoadOptions {
  priority?: "playback" | "viewport" | "prefetch"
  consumer?: string
  current?: () => boolean
}
interface Request {
  positions: number[]
  priority: number
  current: () => boolean
  resolve: () => void
  reject: (error: unknown) => void
}

/** One bounded metadata read at a time; playback precedes speculative views. */
export class QueueHydration {
  readonly items = new Map<number, MusicTrack>()
  private requests: Request[] = []
  private consumers = new Map<string, number>()
  private running = false
  private retired = false
  constructor(private load: (positions: number[]) => Promise<MusicTrack[]>) {}

  retire() {
    this.retired = true
    this.requests.splice(0).forEach(request => request.resolve())
  }

  ensure(positions: number[], options: QueueLoadOptions = {}): Promise<void> {
    const priority = options.priority ?? "playback"
    const consumer = priority === "viewport" ? `viewport:${options.consumer ?? "queue"}`
      : priority === "prefetch" ? "prefetch" : null
    const version = consumer ? (this.consumers.get(consumer) ?? 0) + 1 : 0
    if (consumer) this.consumers.set(consumer, version)
    const current = () => !this.retired && options.current?.() !== false &&
      (!consumer || this.consumers.get(consumer) === version)
    this.requests = this.requests.filter(request => {
      if (request.current()) return true
      request.resolve()
      return false
    })
    if (!positions.length || !current()) return Promise.resolve()
    const result = new Promise<void>((resolve, reject) => {
      this.requests.push({ positions: [...new Set(positions)], priority: { playback: 0, viewport: 1, prefetch: 2 }[priority], current, resolve, reject })
    })
    void this.pump()
    return result
  }

  private async pump() {
    if (this.running) return
    this.running = true
    try {
      while (this.requests.length) {
        this.requests.sort((a, b) => a.priority - b.priority)
        const request = this.requests.shift()!
        if (!request.current()) { request.resolve(); continue }
        const missing = request.positions.filter(position => !this.items.has(position))
        if (!missing.length) { request.resolve(); continue }
        const selected = missing.slice(0, 100)
        try {
          const rows = await this.load(selected)
          if (this.retired) { request.resolve(); continue }
          if (rows.length !== selected.length)
            throw Error("Some queued songs could not be loaded. Try again.")
          rows.forEach((track, index) => {
            this.items.delete(selected[index])
            this.items.set(selected[index], track)
          })
          while (this.items.size > 800) this.items.delete(this.items.keys().next().value!)
          if (!request.current()) { request.resolve(); continue }
          if (missing.length > selected.length) {
            request.positions = missing.slice(selected.length)
            this.requests.push(request)
          } else request.resolve()
        } catch (error) {
          if (request.current()) request.reject(error)
          else request.resolve()
        }
      }
    } finally { this.running = false }
  }
}
