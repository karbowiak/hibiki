import { get, set } from "idb-keyval"
import { playlistJournalDatabase } from "../playlistSync/journal"
import { useProviderStore } from "../stores/providerStore"
import { browseYoutubeMusic, useYoutubeMusicDiscoveryStore, youtubeMusicItemTrack } from "../backends/ytmusic/discovery"
import { youtubeMusicSongMetadata } from "../backends/ytmusic/metadata"
import { itemArtistCredits } from "../lib/artistCredits"
import { COUNTERPART_POLICY, counterpartCandidates, counterpartDeferred, counterpartFailure, recordingFingerprint, selectPlaylistCounterpart, type CounterpartResult } from "./matching"
import { youtubeCounterpartCandidates } from "./youtubeMatching"
import { createYoutubeCatalogMatcher } from "./youtubeCatalogMatching"
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
export function resolveCounterpart(track: MusicTrack, target: Service, force = false, mode: "strict" | "playlist" = "strict",
  catalogCandidates?: (track: MusicTrack) => Promise<MusicTrack[]>): Promise<CounterpartResult> {
  const owner = captureMusicOwner()
  const fingerprint = recordingFingerprint(track)
  const key = JSON.stringify([`counterpart-v${COUNTERPART_POLICY}`, mode, owner.owners, target, fingerprint])
  const choose = (candidates: MusicTrack[]) => {
    if (mode === "playlist") return selectPlaylistCounterpart(track, candidates)
    const choices = counterpartCandidates(track, candidates)
    return choices.length === 1 ? { track: choices[0], confidence: undefined } : null
  }
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
      if (mode === "strict" && (indexed?.status === "ambiguous" || indexed?.status === "limited")) return { status: "ambiguous", checkedAt: Date.now(), message: "Several recordings may match. The original song is retained." }
      if (indexed?.status === "matched" && indexed.selected) {
        const actual = await owner.provider.getTrack(String(indexed.selected))
        if (!owner.current()) throw Error("Music accounts changed.")
        const selected = choose([actual])
        if (actual.id !== String(indexed.selected) || !selected) return unavailable("The Plex recording changed. Retry matching.")
        const result: CounterpartResult = { status: "matched", ...selected, checkedAt: Date.now(), fingerprint }
        await set(key, result, playlistJournalDatabase())
        if (!owner.current()) throw Error("Music accounts changed.")
        return result
      }
      if (mode === "strict" && (indexed?.status === "missing" || indexed?.status === "stale" && indexed.coverage === "complete"))
        return { status: "missing", checkedAt: Date.now(), message: "No current verified Plex recording exists. The original song is retained." }
    } else if (target === "ytmusic" && owner.provider.matchingReverse) {
      const known = await reverseIndexedMusic("track", track.id).catch(failure => { if (!owner.current()) throw failure; return [] })
      if (!owner.current()) throw Error("Music accounts changed.")
      if (known.length) {
        // A removed/unavailable old video must not prevent a new catalog search.
        const actual = await Promise.all(known.map(source => youtubeMusicSongMetadata(source.id).catch(() => null)))
        if (!owner.current()) throw Error("Music accounts changed.")
        const candidates = actual.filter((song, index): song is MusicTrack => song?.id === known[index].id)
        const selected = choose(candidates)
        if (selected) return { status: "matched", ...selected, checkedAt: Date.now(), fingerprint }
        if (mode === "strict" && counterpartCandidates(track, candidates).length > 1) return { status: "ambiguous", checkedAt: Date.now(), message: "Several YTM recordings match. The original song is retained." }
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
        const selected = choose([actual])
        if (actual.id === saved.track.id && selected) return { ...saved, ...selected,
          confidence: saved.confidence !== undefined && selected.confidence !== undefined ? Math.min(saved.confidence, selected.confidence) : selected.confidence }
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
        // Artist/release pages often supply the whole album in a single call.
        // Individual ranked searches are reserved for remaining catalog misses.
        candidates = await youtubeCounterpartCandidates(track, {
          current: owner.current, fuzzy: mode === "playlist", catalog: catalogCandidates, search: async query => {
            const page = await browseYoutubeMusic({ browseId: "hibiki_song_search", params: query }, null, force)
            return page.items.filter(item => item.kind === "song").map(youtubeMusicItemTrack)
          } })
      }
      if (!owner.current()) throw Error("Music accounts changed.")
      const selected = choose(candidates)
      const ambiguous = mode === "strict" && counterpartCandidates(track, candidates).length > 1
      result = selected ? { status: "matched", ...selected, checkedAt: Date.now(), fingerprint }
        : { status: ambiguous ? "ambiguous" : "missing", checkedAt: Date.now(),
          message: ambiguous ? "Several recordings match. The original song is retained." : "No suitable recording found. The original song is retained." }
    } catch (failure) {
      result = counterpartFailure(failure)
    }
    if (!owner.current()) throw Error("Music accounts changed.")
    if (!counterpartDeferred(result)) await set(key, result, playlistJournalDatabase())
    if (!owner.current()) throw Error("Music accounts changed.")
    return result
  })()
  pending.set(runtimeKey, { current: owner.current, promise: work })
  void work.then(() => { if (pending.get(runtimeKey)?.promise === work) pending.delete(runtimeKey) }, () => { if (pending.get(runtimeKey)?.promise === work) pending.delete(runtimeKey) })
  return work
}

/** Playlist playback tolerates a scored best guess; exact consumers opt out. */
export const resolvePlaylistCounterpart = (track: MusicTrack, target: Service, force = false) => resolveCounterpart(track, target, force, "playlist")

/** Share artist and release discovery across all occurrences in this job. Native
 * SWR retains the same catalog pages between batches and client restarts. */
export function createPlaylistCounterpartResolver(tracks: MusicTrack[], force = false, current: () => boolean = () => true) {
  const owner = captureMusicOwner()
  const owns = () => current() && owner.current()
  const catalog = createYoutubeCatalogMatcher(tracks, { current: owns, toTrack: youtubeMusicItemTrack,
    browse: (destination, cursor) => browseYoutubeMusic(destination, cursor, force),
    knownArtists: async group => {
      const ids = [...new Set(group.flatMap(track => itemArtistCredits(track)[0]?.id ? [itemArtistCredits(track)[0].id!] : []))].slice(0, 3)
      const sources = []
      for (const id of ids) sources.push(...await reverseIndexedMusic("artist", id).catch(failure => { if (!owns()) throw failure; return [] }))
      return sources.map(source => source.id)
    },
  })
  return (track: MusicTrack, target: Service) => {
    if (!owns()) return Promise.reject(Error("Music accounts changed."))
    return resolveCounterpart(track, target, force, "playlist", target === "ytmusic" ? catalog : undefined)
  }
}
