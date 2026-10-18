import { recordingFingerprint } from "./matching"
import { playlistServices, type MixedPlaylist, type Service, type SongReference } from "./model"

type Save = (playlist: MixedPlaylist) => Promise<MixedPlaylist>
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function sameRecording(a?: SongReference, b?: SongReference) {
  return a === b || !!a && !!b && a.track.id === b.track.id && !!a.stale === !!b.stale &&
    recordingFingerprint(a.track) === recordingFingerprint(b.track)
}

/** Matching adds proofs; it never restores an old playlist order, write receipt
 * or baseline. Provider reconciliation may have advanced while a lookup ran. */
export function mergeMatchingCheckpoint(latest: MixedPlaylist, before: MixedPlaylist, next: MixedPlaylist) {
  if (before.id !== latest.id || next.id !== latest.id || before.items.length !== next.items.length ||
      before.items.some((row, index) => row.id !== next.items[index].id))
    throw Error("Matching cannot change playlist membership or order.")
  const changes = new Map(next.items.flatMap((row, index) => row === before.items[index] ? [] : [[row.id, { before: before.items[index], next: row }] as const]))
  const targets = playlistServices(latest)
  let changed = false, songsChanged = false
  const items = latest.items.map(row => {
    const change = changes.get(row.id)
    if (!change || row.original !== change.before.original || !sameRecording(row.songs[row.original], change.before.songs[row.original])) return row
    const sides = (["plex", "ytmusic"] as Service[]).filter(side => !same(change.before.songs[side], change.next.songs[side]))
    if (sides.some(side => !sameRecording(row.songs[side], change.before.songs[side]))) return row
    // A newer provider verification takes priority over a stale miss/reset.
    if (!sides.length && !same(row.match, change.before.match)) return row
    if (!sides.length && same(row.match, change.next.match)) return row
    changed = true
    songsChanged ||= sides.some(side => targets.includes(side))
    const songs = { ...row.songs }, remote = { ...row.remote }
    for (const side of sides) {
      songs[side] = change.next.songs[side]
      if (!same(change.before.remote[side], change.next.remote[side])) remote[side] = change.next.remote[side]
    }
    return { ...row, songs, remote, match: change.next.match }
  })
  return { playlist: changed ? { ...latest, items } : latest, songsChanged }
}

/** One lookup producer and one coalescing writer. Lookups run during remote
 * writes; only checkpoints and provider mutation/verification share a lane.
 * This keeps the durable revision and single uncertain-write receipt intact. */
export async function syncAndMatchPlaylist(initial: MixedPlaylist, options: {
  sync(playlist: MixedPlaylist, save: Save): Promise<MixedPlaylist>
  match(playlist: MixedPlaylist, save: Save): Promise<MixedPlaylist>
  save: Save
  current(): boolean
  onSyncState?(running: boolean): void
  flushDelayMs?: number
  maxSyncPasses?: number
}) {
  if (!options.current()) return initial
  let playlist = initial, matchBase = initial, lane = Promise.resolve()
  let dirty = true, matchingDone = false, blocked = false, passes = 0
  let failed: { error: unknown } | undefined, matchingFailed: { error: unknown } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, writer: Promise<void> | undefined
  const available = () => options.current() && !blocked && !failed && passes < (options.maxSyncPasses ?? 10)
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const operation = lane.then(() => {
      if (!options.current()) throw Error("Music accounts changed.")
      return run()
    })
    lane = operation.then(() => {}, () => {})
    return operation
  }
  const retain: Save = async next => {
    if (!options.current()) throw Error("Music accounts changed.")
    playlist = await options.save(next)
    return playlist
  }
  function schedule() {
    if (!available() || timer || writer || !dirty) return
    timer = setTimeout(() => { timer = undefined; startWriter() }, options.flushDelayMs ?? 1000)
  }
  function startWriter() {
    if (!available() || writer || !dirty) return
    clearTimeout(timer); timer = undefined
    writer = serial(async () => {
      dirty = false; passes++
      options.onSyncState?.(true)
      try {
        playlist = await options.sync(playlist, retain)
        blocked = !!playlist.write || playlist.status === "conflict"
        // A bounded write pass can leave a tail; drain it without waiting for
        // another lookup. The scheduler resumes it if this turn's budget ends.
        dirty ||= playlist.status === "syncing"
      } finally { options.onSyncState?.(false) }
    }).catch(error => { failed = { error } }).finally(() => {
      writer = undefined
      if (!matchingDone) schedule()
    })
  }
  const checkpoint: Save = async next => {
    const before = matchBase
    const saved = await serial(async () => {
      const merged = mergeMatchingCheckpoint(playlist, before, next)
      if (merged.playlist !== playlist) await retain(merged.playlist)
      dirty ||= merged.songsChanged
      return playlist
    })
    matchBase = saved
    schedule()
    return saved
  }
  startWriter()
  try { await options.match(initial, checkpoint) }
  catch (error) { matchingFailed = { error } }
  finally {
    matchingDone = true
    clearTimeout(timer); timer = undefined
    // Join any in-flight write before releasing the playlist's outer lane.
    if (writer) await writer
    while (!matchingFailed && available() && dirty) {
      startWriter()
      if (writer) await writer
    }
    clearTimeout(timer)
  }
  if (matchingFailed) throw matchingFailed.error
  if (failed) throw failed.error
  return playlist
}
