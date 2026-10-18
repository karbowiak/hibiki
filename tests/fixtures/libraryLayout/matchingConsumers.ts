import type { MusicAlbum, MusicArtist, MusicTrack } from "../../../src/types/music"
import { startMatchingUpdates } from "../../../src/matching/updates"
import { resolveMusicEntity } from "../../../src/lib/musicLinks"
import { resolveCounterpart } from "../../../src/mixedPlaylists/counterparts"
import { retrievePlaylistCandidates } from "../../../src/playlistSync/candidateRetrieval"

/** Disposable browser provider; all account and native I/O stays in this fixture. */
export function installMatchingConsumers(provider: any, artist: MusicArtist, album: MusicAlbum, track: MusicTrack) {
  const w = window as any, callbacks = new Map<number, (value: unknown) => void>(), handlers: number[] = []
  let callback = 100000, revision = 1, selected = true
  const counts = { search: 0, lookups: 0, artist: 0, track: 0, rows: 0 }, times: number[] = []
  const native = w.__TAURI_INTERNALS__, invoke = native.invoke
  const transform = native.transformCallback
  native.transformCallback = (fn: (value: unknown) => void) => { const id = ++callback; callbacks.set(id, fn); return id }
  native.invoke = async (command: string, args: any) => {
    if (command === "plugin:event|listen" && args.event === "matching-index-changed") { handlers.push(args.handler); return handlers.length }
    return invoke(command, args)
  }
  const removed = new Set<number>()
  const sourceTrack = { ...track, id: "ytmusic:a1234567890", guid: null }
  Object.assign(provider, {
    matchingResolve: async (_owner: string, sources: any[]) => {
      counts.lookups++
      return sources.map(source => ({ sourceId: source.id, status: selected ? "matched" : "missing", candidates: [],
        selected: selected ? source.kind === "artist" ? 42 : source.kind === "album" ? 43 : 44 : null,
        coverage: "complete", revision, cached: true, limited: false, recordingIdentity: null }))
    },
    matchingRows: async (_kind: string, ids: number[]) => { counts.rows++; return ids.map(id => ({ id, state: removed.has(id) ? "removed" : "active", row: null })) },
    matchingReverse: async () => [],
    matchingChanges: async (cursor: number) => ({ revision, coverage: "complete", cursor: revision,
      reset: cursor > revision, changes: cursor < revision ? [{ sequence: revision, kind: "artist", id: 42,
        titleKey: "youtube fixture artist", observed: Date.now(), removed: !selected }] : [] }),
    search: async () => { counts.search++; return [] },
    getArtist: async (id: string) => { counts.artist++; return { ...artist, id, title: "YouTube Fixture Artist" } },
    getAlbum: async (id: string) => ({ ...album, id }),
    getTrack: async (id: string) => { counts.track++; return { ...track, id } },
  })
  const detach = startMatchingUpdates()
  w.fixtureMatchingConsumers = {
    counts: () => ({ ...counts }),
    state: (present: boolean) => {
      selected = present; revision++
      if (present) removed.delete(42); else removed.add(42)
      for (const handler of handlers) callbacks.get(handler)?.({ event: "matching-index-changed", id: handler, payload: { scope: provider.cacheScope } })
    },
    links: async () => {
      const start = performance.now()
      const href = await resolveMusicEntity({ kind: "artist", id: "ytmusic:UC_fixture", name: "YouTube Fixture Artist" })
      times.push(performance.now() - start)
      return href
    },
    queue: async () => resolveCounterpart(sourceTrack, "plex"),
    playlist: async () => retrievePlaylistCandidates(provider, { id: "external-track", title: track.title, artist: track.artistName,
      album: track.albumName, durationMs: track.duration }, () => true),
    times: () => times,
    retire: () => { detach(); native.transformCallback = transform; native.invoke = invoke },
  }
}
