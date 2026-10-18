import type { YoutubeMusicBrowsePage, YoutubeMusicItem } from "../backends/ytmusic/discovery"

const TTL = 15 * 60_000
interface Owner { revision: number; accountId?: string | null }
export interface YoutubePlaylistHydration {
  key: string
  id: string
  title: string
  owner: Owner
  total?: number
  resume?: { cursor: string; completed: number; pages: number; visited?: string[] }
}
interface Result { done: boolean; resume?: YoutubePlaylistHydration["resume"] }
export const sameYoutubePlaylistOwner = (a: Owner, b: Owner) =>
  a.revision === b.revision && a.accountId === b.accountId

/** The ordinary native browse cache stores every page, including continuations.
 * Four pages per claim leave room for playback, sync and other collections. */
export async function hydrateYoutubePlaylist(job: YoutubePlaylistHydration, deps: {
  active(): boolean
  read(cursor: string | null): Promise<YoutubeMusicBrowsePage>
  progress(completed: number, total?: number): void
}): Promise<Result> {
  const check = () => { if (!deps.active()) throw Error("YouTube Music connection changed.") }
  let cursor = job.resume?.cursor ?? null,
    completed = job.resume?.completed ?? 0,
    pages = job.resume?.pages ?? 0
  // Keep bounded fingerprints across claims so a cycle spanning several turns
  // cannot repeatedly traverse the same cached continuation pages.
  const fingerprint = async (value: string) => Array.from(new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).subarray(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")
  const visited = new Set(job.resume?.visited ?? [])
  check()
  deps.progress(completed, job.total)
  for (let count = 0; count < 4; count++) {
    check()
    if (pages >= 1000) throw Error("YouTube Music playlist paging did not finish.")
    if (cursor) {
      const key = await fingerprint(cursor)
      if (visited.has(key)) throw Error("YouTube Music playlist paging did not advance.")
      visited.add(key)
    }
    const page = await deps.read(cursor)
    check()
    completed += page.items.length
    pages++
    cursor = page.continuation
    deps.progress(completed, cursor ? (job.total ? Math.max(job.total, completed) : undefined) : completed)
    if (!cursor) return { done: true }
    if (visited.has(await fingerprint(cursor))) throw Error("YouTube Music playlist paging did not advance.")
  }
  return { done: false, resume: { cursor: cursor!, completed, pages, visited: [...visited] } }
}

/** One coalescing feeder for the sidebar and every library view. Metadata only;
 * audio preparation keeps using the playback/download queues. */
export function createYoutubePlaylistCache(deps: {
  owner(): Owner | null
  run(job: YoutubePlaylistHydration): Promise<Result>
  now?: () => number
}) {
  let owner: Owner | null = null, epoch = 0, running = false
  let activeJob: YoutubePlaylistHydration | undefined
  let roster: YoutubeMusicItem[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  const waiting = new Map<string, YoutubePlaylistHydration>()
  const offered = new Map<string, { stamp: string; at: number }>()
  const now = deps.now ?? Date.now
  const owns = () => {
    const current = deps.owner()
    return !!owner && !!current && sameYoutubePlaylistOwner(owner, current)
  }
  function reset() {
    epoch++
    owner = null
    roster = []
    waiting.clear()
    offered.clear()
    clearInterval(timer)
    timer = undefined
  }
  async function pump() {
    if (running) return
    running = true
    try {
      while (waiting.size && owns()) {
        const job = waiting.values().next().value!
        waiting.delete(job.id)
        const version = epoch
        const admission = offered.get(job.id)
        activeJob = job
        let continued = false
        try {
          const result = await deps.run(job)
          if (version === epoch && owns() && !result.done &&
            offered.get(job.id) === admission && !waiting.has(job.id)) {
            waiting.set(job.id, { ...job, resume: result.resume })
            continued = true
          }
        } catch {
          // Retain cached pages; retry on the next warmup, never in a tight loop.
        } finally {
          if (!continued && version === epoch && admission && offered.get(job.id) === admission)
            admission.at = now()
          activeJob = undefined
        }
      }
    } finally {
      running = false
    }
  }
  function offer(items: YoutubeMusicItem[]) {
    const current = deps.owner()
    if (!current) { reset(); return }
    if (!owner || !sameYoutubePlaylistOwner(owner, current)) reset()
    owner = { revision: current.revision, accountId: current.accountId }
    // Liked songs have their own sync. Personalized radio queues are not saved
    // library playlists and should not be exhaustively traversed at startup.
    roster = items.filter(item => item.kind === "playlist" && item.id.startsWith("VL") &&
      item.id !== "VLLM" && !item.id.startsWith("VLRD"))
    const present = new Set(roster.map(item => item.id))
    for (const id of waiting.keys()) if (!present.has(id)) waiting.delete(id)
    for (const id of offered.keys()) if (!present.has(id)) offered.delete(id)
    for (const item of roster) {
      const stamp = JSON.stringify([item.title, item.trackCount]), previous = offered.get(item.id)
      if (previous?.stamp === stamp && (now() - previous.at < TTL || waiting.has(item.id) ||
        activeJob?.id === item.id && sameYoutubePlaylistOwner(activeJob.owner, owner))) continue
      offered.set(item.id, { stamp, at: now() })
      waiting.set(item.id, { key: `ytmusic:playlist:${item.id}`, id: item.id,
        title: item.title, owner, total: item.trackCount || undefined })
    }
    void pump()
    if (!timer) timer = setInterval(() => offer(roster), TTL)
  }
  return { offer, reset }
}
