import { create } from "zustand"
import { get, update } from "idb-keyval"
import { invoke } from "@tauri-apps/api/core"
import type { MusicTrack } from "../../types/music"
import { playlistJournalDatabase } from "../../playlistSync/journal"
import { captureMusicOwner, resolveCounterpart } from "../../mixedPlaylists/counterparts"
import { useYoutubeMusicLikesStore } from "./likes"
import { favoritesRemote } from "../../favorites/native"
import { useLastfmStore } from "../../metadata/lastfm/authStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
import { useFavoritesStore } from "../../stores/favoritesStore"
import { saveTrackRatingToPlex } from "../../favorites/saveRating"
import { isYoutubeMusicId } from "./tracks"
import { matchingUpdateAffectsRecording } from "../../matching/changes"
import type { MatchingUpdate } from "../../matching/updates"

export const youtubeRatingLiked = (value: number | null) => (value ?? 0) > 2
export const scrobbleRatingLoved = (value: number | null) => (value ?? 0) >= 6
export interface YoutubeMusicRating {
  id: string
  owner: string
  track: MusicTrack
  value: number | null
  changedAt: number
  plexOwner?: string
  serviceOwners?: Partial<Record<"lastfm" | "listenbrainz", string>>
  saved: Partial<Record<"ytmusic" | "plex" | "lastfm" | "listenbrainz", string>>
  error?: string
}
interface State {
  owner: string | null
  entries: Record<string, YoutubeMusicRating>
  loaded: boolean
  saving: Record<string, boolean>
  load(owner: string): Promise<void>
  rate(track: MusicTrack, value: number | null): Promise<boolean>
  resume(): Promise<void>
  retryPlexMatches(update?: MatchingUpdate): Promise<void>
}
const key = (owner: string) => `ytmusic-stars-v1:${owner}`
const lanes = new Map<string, Promise<void>>()
const pendingLoads = new Map<string, Promise<void>>()
let loadVersion = 0
let matchingRetry: Promise<void> | undefined, matchingCursor = 0
async function retain(entry: YoutubeMusicRating, expected?: string) {
  let saved: YoutubeMusicRating | undefined
  await update<Record<string, YoutubeMusicRating>>(key(entry.owner), previous => {
    const rows = previous ?? {}, before = rows[entry.track.id]
    if (expected && before?.id !== expected) return rows
    saved = entry
    return { ...rows, [entry.track.id]: entry }
  }, playlistJournalDatabase())
  if (saved && useYoutubeMusicRatingsStore.getState().owner === entry.owner)
    useYoutubeMusicRatingsStore.setState(state => ({ entries: { ...state.entries, [entry.track.id]: entry } }))
  return saved
}
async function syncSong(owner: string, trackId: string) {
  const lane = `${owner}:${trackId}`, previous = lanes.get(lane)
  if (previous) return previous
  const work = (async () => {
    const capture = captureMusicOwner()
    const current = () => capture.current() && capture.owners.ytmusic === owner && useYoutubeMusicRatingsStore.getState().owner === owner
    for (let pass = 0; pass < 8 && current(); pass++) {
      let entry = useYoutubeMusicRatingsStore.getState().entries[trackId]
      if (!entry) return
      const intent = entry.id
      const latest = () => current() && useYoutubeMusicRatingsStore.getState().entries[trackId]?.id === intent
      const acknowledge = async (service: keyof YoutubeMusicRating["saved"], account: string) => {
        if (!latest()) return
        entry = { ...useYoutubeMusicRatingsStore.getState().entries[trackId], error: undefined,
          saved: { ...useYoutubeMusicRatingsStore.getState().entries[trackId].saved, [service]: account } }
        await retain(entry, intent)
      }
      const failures: string[] = []
      if (entry.saved.ytmusic !== owner) try {
        if (!latest()) continue
        const liked = youtubeRatingLiked(entry.value)
        await invoke("ytmusic_set_song_like", { videoId: trackId.slice(8), liked, expectedAccount: owner })
        if (!latest()) continue
        useYoutubeMusicLikesStore.setState(state => ({ mutation: state.mutation + 1, entries: { ...state.entries,
          [trackId]: { ...state.entries[trackId], track: entry.track, liked, manual: true, checking: false, saving: false, error: null, changedAt: new Date(entry.changedAt).toISOString() } } }))
        await acknowledge("ytmusic", owner)
      } catch { failures.push("YouTube Music like is pending.") }
      if (!latest()) continue
      let matched: MusicTrack | undefined, recordingMbid: string | undefined
      if (entry.plexOwner && entry.plexOwner === capture.owners.plex && capture.provider && !capture.provider.isOffline && entry.saved.plex !== entry.plexOwner) {
        try {
          const match = await resolveCounterpart(entry.track, "plex")
          if (!latest()) continue
          if (match.status !== "matched") throw Error(match.status === "ambiguous" ? "Plex match is ambiguous." : "Plex recording has not been matched yet.")
          matched = match.track
          const favorites = useFavoritesStore.getState()
          if (!favorites.loaded || favorites.provider !== capture.provider || favorites.session !== capture.provider.playbackSession) await favorites.load(capture.provider)
          if (!latest()) continue
          const rating = await useFavoritesStore.getState().ratingChanged(matched.id, matched.title, matched.artistName, entry.value, matched)
          if (!latest()) continue
          await saveTrackRatingToPlex(capture.provider, rating)
          if (!latest()) continue
          await acknowledge("plex", entry.plexOwner)
        } catch (failure) { failures.push(failure instanceof Error ? failure.message : "Plex rating is pending.") }
      }
      if (!latest()) continue
      for (const service of ["lastfm", "listenbrainz"] as const) {
        const state = service === "lastfm" ? useLastfmStore.getState() : useListenBrainzStore.getState()
        if (!state.isAuthenticated || !state.isEnabled || !state.username || entry.serviceOwners?.[service] !== state.username || entry.saved[service] === state.username) continue
        const accountName = state.username
        const serviceCurrent = () => latest() && (service === "lastfm" ? useLastfmStore.getState() : useListenBrainzStore.getState()).username === accountName
        try {
          const account = await favoritesRemote.account(service)
          if (!serviceCurrent() || account.user !== accountName) continue
          if (service === "listenbrainz") {
            if (!matched && capture.provider && entry.plexOwner === capture.owners.plex) {
              const result = await resolveCounterpart(entry.track, "plex")
              if (result.status === "matched") matched = result.track
            }
            if (!serviceCurrent()) continue
            if (matched && capture.provider?.resolvePlaylistRecording) {
              const resolved = await capture.provider.resolvePlaylistRecording({ id: matched.id, title: matched.title, artist: matched.artistName, album: matched.albumName, durationMs: matched.duration })
              if (resolved.status === "verified") recordingMbid = resolved.recordingMbid
            }
            if (!recordingMbid) throw Error("ListenBrainz feedback is pending a verified recording ID.")
          }
          if (!serviceCurrent()) continue
          const record = { key: `${service}:${trackId}`, title: entry.track.title, artist: entry.track.originalTitle || entry.track.artistName,
            album: entry.track.albumName, durationMs: entry.track.duration, recordingMbid }
          const before = await favoritesRemote.peek(account, record)
          if (!serviceCurrent()) continue
          const desired = scrobbleRatingLoved(entry.value)
          if (before !== desired && await favoritesRemote.set(account, record, desired, before) !== desired) throw Error("Feedback could not be verified.")
          if (serviceCurrent()) await acknowledge(service, accountName)
        } catch (failure) { failures.push(failure instanceof Error ? failure.message : `${service} feedback is pending.`) }
      }
      if (!latest()) continue
      await retain({ ...entry, error: failures.length ? failures.join(" ") : undefined }, intent)
      return
    }
  })()
  lanes.set(lane, work)
  void work.finally(() => {
    if (lanes.get(lane) === work) lanes.delete(lane)
    // An intent admitted during the last acknowledgement still needs its turn.
  }).catch(() => {})
  return work
}

export const useYoutubeMusicRatingsStore = create<State>((set, state) => ({
  owner: null, entries: {}, loaded: false, saving: {},
  load: owner => {
    if (state().owner === owner && state().loaded) return Promise.resolve()
    const pending = pendingLoads.get(owner)
    if (pending && state().owner === owner) return pending
    const version = ++loadVersion
    set({ owner, entries: {}, loaded: false })
    const work = (async () => {
      const entries = (await get<Record<string, YoutubeMusicRating>>(key(owner), playlistJournalDatabase())) ?? {}
      if (version !== loadVersion || state().owner !== owner) return
      set({ entries, loaded: true })
      void state().resume().catch(() => {})
    })()
    pendingLoads.set(owner, work)
    void work.finally(() => { if (pendingLoads.get(owner) === work) pendingLoads.delete(owner) }).catch(() => {})
    return work
  },
  rate: async (track, value) => {
    if (!isYoutubeMusicId(track.id) || (value !== null && ![2, 4, 6, 8, 10].includes(value))) throw Error("Choose one to five stars, or clear the rating.")
    const capture = captureMusicOwner(), owner = capture.owners.ytmusic
    if (!owner) throw Error("Connect YouTube Music before rating a song.")
    await state().load(owner)
    if (!capture.current()) return false
    const lastfm = useLastfmStore.getState(), listenbrainz = useListenBrainzStore.getState()
    const entry: YoutubeMusicRating = { id: crypto.randomUUID(), owner, track, value, changedAt: Date.now(), plexOwner: capture.owners.plex,
      serviceOwners: { ...(lastfm.isAuthenticated && lastfm.username ? { lastfm: lastfm.username } : {}),
        ...(listenbrainz.isAuthenticated && listenbrainz.username ? { listenbrainz: listenbrainz.username } : {}) }, saved: {} }
    set(s => ({ saving: { ...s.saving, [track.id]: true } }))
    try {
      await retain(entry)
      if (capture.current()) void syncSong(owner, track.id).catch(() => {})
      return true
    } finally { set(s => ({ saving: { ...s.saving, [track.id]: false } })) }
  },
  resume: async () => {
    const owner = state().owner
    if (!owner || !state().loaded) return
    // Bounded per tick; already acknowledged songs require no YTM/Plex writes.
    for (const entry of Object.values(state().entries).filter(entry => !entry.saved.ytmusic || (entry.plexOwner && !entry.saved.plex) || entry.error ||
      Object.entries(entry.serviceOwners ?? {}).some(([service, account]) => entry.saved[service] !== account)).slice(0, 20))
      await syncSong(owner, entry.track.id)
  },
  retryPlexMatches: update => {
    if (matchingRetry) return matchingRetry
    const work = (async () => {
      const capture = captureMusicOwner(), owner = state().owner
      if (!owner || !state().loaded || !capture.current() || !capture.provider?.matchingResolve || capture.provider.isOffline || capture.owners.ytmusic !== owner) return
      if (update && update.provider !== capture.provider) return
      const entries = Object.values(state().entries).filter(entry => entry.plexOwner === capture.owners.plex && entry.saved.plex !== entry.plexOwner &&
        (!update || matchingUpdateAffectsRecording(update, entry.track)))
      if (!entries.length) return
      const batch = Array.from({ length: Math.min(20, entries.length) }, (_, index) => entries[(matchingCursor + index) % entries.length])
      matchingCursor = (matchingCursor + batch.length) % entries.length
      const [{ queryIndexedMusic }, { trackMatchingSource }] = await Promise.all([import("../../matching/service"), import("../../matching/sources")])
      const results = await Promise.all(batch.map(entry => queryIndexedMusic(trackMatchingSource(entry.track)).catch(() => null)))
      for (let index = 0; index < batch.length && capture.current() && state().owner === owner; index++) {
        const entry = batch[index]
        if (results[index]?.status === "matched" && state().entries[entry.track.id]?.id === entry.id) await syncSong(owner, entry.track.id)
      }
    })()
    matchingRetry = work
    void work.finally(() => { if (matchingRetry === work) matchingRetry = undefined }).catch(() => {})
    return work
  },
}))
