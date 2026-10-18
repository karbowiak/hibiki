import { get, set } from "idb-keyval"
import { playlistJournalDatabase } from "../playlistSync/journal"
import { useProviderStore } from "../stores/providerStore"
import { browseYoutubeMusic, useYoutubeMusicDiscoveryStore, youtubeMusicItemTrack } from "../backends/ytmusic/discovery"
import { youtubeMusicSongMetadata } from "../backends/ytmusic/metadata"
import { itemArtistCredits } from "../lib/artistCredits"
import { counterpartCandidates, recordingFingerprint, type CounterpartResult } from "./matching"
import type { MusicTrack } from "../types/music"
import type { Owners, Service } from "./model"
import { resolveIndexedMusic, reverseIndexedMusic } from "../matching/service"
import { trackMatchingSource } from "../matching/sources"

export function captureMusicOwner() {
  const provider = useProviderStore.getState().provider
  const session = provider?.playbackSession, scope = provider?.cacheScope
  const youtube = useYoutubeMusicDiscoveryStore.getState()
  const owners: Owners = { ...(scope ? { plex: scope } : {}), ...(youtube.connected && youtube.accountId ? { ytmusic: youtube.accountId } : {}) }
  const current = () => useProviderStore.getState().provider === provider && provider?.playbackSession === session &&
    provider?.cacheScope === scope && useYoutubeMusicDiscoveryStore.getState().revision === youtube.revision &&
    useYoutubeMusicDiscoveryStore.getState().accountId === youtube.accountId &&
    useYoutubeMusicDiscoveryStore.getState().connected === youtube.connected
  return { provider, owners, current, youtube }
}
const pending = new Map<string, { current: () => boolean; promise: Promise<CounterpartResult> }>()
/** Shared persisted proof used by playlist conversion, exact ratings and lyrics.
 * Failed/ambiguous results have a short retry window; force explicitly bypasses it. */
export function resolveCounterpart(track: MusicTrack, target: Service, force = false): Promise<CounterpartResult> {
  const owner = captureMusicOwner()
  const fingerprint = recordingFingerprint(track)
  const key = JSON.stringify(["counterpart-v1", owner.owners, target, fingerprint])
  const runtimeKey = `${key}:${String(owner.provider?.playbackSession)}:${owner.youtube.revision}:force:${force}`
  const active = pending.get(runtimeKey)
  if (active?.current()) return active.promise
  const work = (async (): Promise<CounterpartResult> => {
    const unavailable = (message: string): CounterpartResult => ({ status: "failed", checkedAt: Date.now(), message })
    if (!owner.owners.plex || !owner.owners.ytmusic || !owner.provider || owner.provider.isOffline)
      return unavailable("Connect the original Plex library and YouTube Music account to match this song.")
    // Read the revision-aware shared proof before legacy fallback receipts. A
    // previous miss must not hide a newly indexed counterpart for five minutes.
    if (target === "plex" && owner.provider.matchingResolve) {
      const indexed = await resolveIndexedMusic(trackMatchingSource(track), force).catch(failure => { if (!owner.current()) throw failure; return null })
      if (!owner.current()) throw Error("Music accounts changed.")
      if (indexed?.status === "ambiguous" || indexed?.status === "limited") return { status: "ambiguous", checkedAt: Date.now(), message: "Several recordings may match. The original song is retained." }
      if (indexed?.status === "matched" && indexed.selected) {
        const actual = await owner.provider.getTrack(String(indexed.selected))
        if (!owner.current()) throw Error("Music accounts changed.")
        if (actual.id !== String(indexed.selected) || counterpartCandidates(track, [actual]).length !== 1) return unavailable("The Plex recording changed. Retry matching.")
        const result: CounterpartResult = { status: "matched", track: actual, checkedAt: Date.now(), fingerprint }
        await set(key, result, playlistJournalDatabase())
        if (!owner.current()) throw Error("Music accounts changed.")
        return result
      }
      if (indexed?.status === "missing" || indexed?.status === "stale" && indexed.coverage === "complete")
        return { status: "missing", checkedAt: Date.now(), message: "No current verified Plex recording exists. The original song is retained." }
    } else if (target === "ytmusic" && owner.provider.matchingReverse) {
      const known = await reverseIndexedMusic("track", track.id).catch(failure => { if (!owner.current()) throw failure; return [] })
      if (!owner.current()) throw Error("Music accounts changed.")
      if (known.length) {
        const actual = await Promise.all(known.map(source => youtubeMusicSongMetadata(source.id)))
        if (!owner.current()) throw Error("Music accounts changed.")
        const choices = counterpartCandidates(track, actual.filter((song, index) => song.id === known[index].id))
        if (choices.length === 1) return { status: "matched", track: choices[0], checkedAt: Date.now(), fingerprint }
        if (choices.length > 1) return { status: "ambiguous", checkedAt: Date.now(), message: "Several YTM recordings match. The original song is retained." }
      }
    }
    const saved = !force ? await get<CounterpartResult>(key, playlistJournalDatabase()) : undefined
    if (!owner.current()) throw Error("Music accounts changed.")
    if (saved && Date.now() - saved.checkedAt < (saved.status === "matched" ? 86400000 : 300000)) {
      if (saved.status !== "matched") return saved
      // A stored mapping never fabricates a local song or bypasses a removed item.
      try {
        const actual = target === "plex" ? await owner.provider.getTrack(saved.track.id) : await youtubeMusicSongMetadata(saved.track.id)
        if (!owner.current()) throw Error("Music accounts changed.")
        if (actual.id === saved.track.id && counterpartCandidates(track, [actual]).length === 1) return { ...saved, track: actual }
      } catch { if (!owner.current()) throw Error("Music accounts changed.") }
    }
    let result: CounterpartResult
    try {
      let candidates: MusicTrack[]
      const artist = itemArtistCredits(track).map(credit => credit.name).join(", ")
      if (target === "plex") {
        if (owner.provider.findPlaylistCandidates) {
          const found = await owner.provider.findPlaylistCandidates({ id: track.id, title: track.title, artist, album: track.albumName, durationMs: track.duration })
          if (found.unavailable || found.truncated) throw Error("Search was incomplete. Retry matching.")
          candidates = found.tracks
        } else {
          candidates = (await owner.provider.search(track.title, "track")).flatMap(item => item.type === "track" ? [item] : [])
        }
      } else {
        const page = await browseYoutubeMusic({ browseId: "hibiki_song_search", params: `${artist} ${track.title}` }, null, force)
        if (page.continuation) throw Error("Search was incomplete. Retry matching.")
        candidates = page.items.filter(item => item.kind === "song").map(youtubeMusicItemTrack)
      }
      if (!owner.current()) throw Error("Music accounts changed.")
      const choices = counterpartCandidates(track, candidates)
      result = choices.length === 1 ? { status: "matched", track: choices[0], checkedAt: Date.now(), fingerprint }
        : { status: choices.length ? "ambiguous" : "missing", checkedAt: Date.now(),
          message: choices.length ? "Several recordings match. The original song is retained." : "No verified recording found. The original song is retained." }
    } catch (failure) {
      result = unavailable(failure instanceof Error ? failure.message : "Song lookup failed. Retry matching.")
    }
    if (!owner.current()) throw Error("Music accounts changed.")
    await set(key, result, playlistJournalDatabase())
    if (!owner.current()) throw Error("Music accounts changed.")
    return result
  })()
  pending.set(runtimeKey, { current: owner.current, promise: work })
  void work.then(() => { if (pending.get(runtimeKey)?.promise === work) pending.delete(runtimeKey) }, () => { if (pending.get(runtimeKey)?.promise === work) pending.delete(runtimeKey) })
  return work
}
