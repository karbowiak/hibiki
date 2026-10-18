import { backgroundActions } from "../background/actions"
import { create } from "zustand"
import { useProviderStore } from "./providerStore"
import { useLastfmStore } from "../metadata/lastfm/authStore"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import {
  emptyFavorites,
  setFavorite,
  seedFavoriteRatings,
} from "../favorites/model"
import {
  favoriteReference,
  type FavoriteState,
  type FavoriteService,
  type FavoriteMetadata,
  type FavoriteRecording,
} from "../favorites/types"
import {
  favoriteRatingIndex,
  favoriteRatingIntent,
  LIKED_RATING,
  type FavoriteTrackRating,
  type FavoriteRatingIntent,
} from "../favorites/ratings"
import { favoritesRemote } from "../favorites/native"
import { syncFavorites, type FavoriteSyncServices } from "../favorites/sync"
import { validFavorite, validFavoriteMetadata } from "../favorites/validation"
import { providerPlaylistAccount } from "../playlistSync/provider"
import { retrievePlaylistCandidates } from "../playlistSync/candidateRetrieval"
import { matchTrack, recordingMbid } from "../playlistSync/matching"
import type { MusicProvider } from "../providers/types"
import type { MusicTrack } from "../types/music"
import { beginActivity } from "../activity/store"
import { favoriteMatchBacklog, favoriteMatchingProgress } from "../favorites/matchingProgress"
interface State {
  collection: FavoriteState
  likedTrackIds: Set<string>
  ratingsByTrackId: Map<string, FavoriteTrackRating>
  provider: MusicProvider | null
  session: unknown
  loaded: boolean
  loading: boolean
  running: boolean
  /** Local user changes only; provider imports/checkpoints never request sync. */
  syncRequest: number
  resetting: boolean
  error: string | null
  issues: Partial<Record<FavoriteService, string>>
  load(provider?: MusicProvider | null): Promise<void>
  update(
    change: (state: FavoriteState) => FavoriteState,
    provider?: MusicProvider | null
  ): Promise<FavoriteState>
  toggle(track: MusicTrack, liked: boolean): Promise<void>
  toggleEntry(id: string, liked: boolean): Promise<void>
  assignRecording(id: string, mbid: string): Promise<void>
  ratingChanged(
    id: string,
    title: string,
    artist: string,
    rating: number | null,
    track?: MusicTrack
  ): Promise<FavoriteRatingIntent>
  confirmRating(
    intent: FavoriteRatingIntent,
    provider: MusicProvider
  ): Promise<void>
  configure(
    service: FavoriteService,
    enabled: boolean,
    playlistId?: string
  ): Promise<void>
  sync(options?: { retryUnknown?: boolean; refresh?: boolean }): Promise<void>
  resetSync(): Promise<void>
  recoverPlex(id: string): Promise<void>
  matchMissing(force?: boolean): Promise<void>
  linkTrack(entryId: string, track: MusicTrack): Promise<void>
  seedRatings(tracks: MusicTrack[]): Promise<void>
}
let queue: Promise<unknown> = Promise.resolve(),
  loadJob: Promise<void> | undefined,
  loadOwner: MusicProvider | null = null,
  loadingSession: unknown
let syncOwner: { provider: MusicProvider; session: unknown } | undefined
let matchEpoch = 0
let matchOwner: { provider: MusicProvider; session: unknown; epoch: number } | undefined
function requestSync() {
  useFavoritesStore.setState(state => ({ syncRequest: state.syncRequest + 1 }))
}
function owns(provider: MusicProvider | null, session: unknown) {
  return (
    !!provider &&
    useProviderStore.getState().provider === provider &&
    provider.playbackSession === session
  )
}
function likedIds(collection: FavoriteState) {
  return new Set(
    Object.values(collection.entries)
      .filter((row) => row.liked)
      .flatMap((row) => row.localTrackIds)
  )
}
export const useFavoritesStore = create<State>((set, get) => ({
  collection: emptyFavorites(),
  likedTrackIds: new Set(),
  ratingsByTrackId: new Map(),
  provider: null,
  session: null,
  loaded: false,
  loading: false,
  running: false,
  syncRequest: 0,
  resetting: false,
  error: null,
  issues: {},
  async load(provider = useProviderStore.getState().provider) {
    if (!provider?.favorites) {
      set({
        provider: null,
        session: null,
        collection: emptyFavorites(),
        likedTrackIds: new Set(),
        ratingsByTrackId: new Map(),
        loaded: false,
        loading: false,
        running: false,
        resetting: false,
        issues: {},
        error: null,
      })
      return
    }
    const session = provider.playbackSession
    if (
      get().loaded &&
      get().provider === provider &&
      get().session === session
    )
      return
    if (loadJob && loadOwner === provider && loadingSession === session)
      return loadJob
    loadOwner = provider
    loadingSession = session
    set({
      provider,
      session,
      loaded: false,
      loading: true,
      running: false,
      resetting:
        get().provider === provider &&
        get().session === session &&
        get().resetting,
      error: null,
      collection: emptyFavorites(),
      likedTrackIds: new Set(),
      ratingsByTrackId: new Map(),
      issues: {},
    })
    const native = provider.favorites
    const job = (async () => {
      try {
        const profile = await native.load(),
          entries: FavoriteState["entries"] = {}
        if (
          !validFavoriteMetadata(profile.metadata) ||
          !Number.isSafeInteger(profile.revision) ||
          profile.revision < 0 ||
          !Number.isSafeInteger(profile.total) ||
          profile.total < 0 ||
          profile.total > 100000
        )
          throw Error("Saved favorites require a newer Hibiki version")
        for (let offset = 0; offset < profile.total; offset += 1000) {
          const rows = await native.page(offset, 1000)
          if (!owns(provider, session)) return
          if (
            !rows.length ||
            rows.length > 1000 ||
            offset + rows.length > profile.total
          )
            throw Error("Saved favorite pages are incomplete")
          for (const row of rows) {
            if (
              !validFavorite(row.payload) ||
              row.id !== row.payload.id ||
              typeof row.payload.liked !== "boolean" ||
              entries[row.id]
            )
              throw Error("Saved favorites are invalid")
            entries[row.id] = row.payload
          }
        }
        const verified = await native.load()
        if (verified.revision !== profile.revision)
          throw Error("Favorites changed while loading; retry")
        let collection = {
          ...profile.metadata,
          entries,
          revision: profile.revision,
        }
        if (!owns(provider, session)) return
        if (
          collection.ratingModel !== 1 ||
          collection.settings.ratingThreshold !== LIKED_RATING
        ) {
          const metadata: FavoriteMetadata = {
            ...profile.metadata,
            ratingModel: 1,
            settings: { ...collection.settings, ratingThreshold: LIKED_RATING },
            ratingsImported: false,
          }
          const revision = await native.save(collection.revision, metadata, [])
          if (!owns(provider, session)) return
          collection = { ...metadata, entries, revision }
        }
        if (owns(provider, session))
          set({
            collection,
            ratingsByTrackId: favoriteRatingIndex(collection),
            likedTrackIds: likedIds(collection),
            loaded: true,
            loading: false,
          })
      } catch (error) {
        if (owns(provider, session)) {
          set({
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "Cannot read saved favorites",
          })
          throw error
        }
      }
    })()
    loadJob = job
    try {
      await job
    } finally {
      if (loadJob === job) loadJob = undefined
    }
  },
  async update(change, provider = useProviderStore.getState().provider) {
    const session = provider?.playbackSession
    const job = queue
      .catch(() => {})
      .then(async () => {
        if (!provider?.favorites || !owns(provider, session))
          throw Error("Favorite library changed")
        await get().load(provider)
        if (!owns(provider, session) || !get().loaded)
          throw Error("Favorite library changed")
        const previous = get().collection,
          next = change(previous)
        if (next === previous) return previous
        const metadata: FavoriteMetadata = {
          version: 1,
          settings: next.settings,
          bindings: next.bindings,
          ratingsImported: next.ratingsImported,
          ratingModel: next.ratingModel,
        }
        const rows = Object.values(next.entries)
          .filter((item) => item !== previous.entries[item.id])
          .map((payload) => ({ id: payload.id, payload }))
        if (
          !rows.length &&
          JSON.stringify(metadata) ===
            JSON.stringify({
              version: 1,
              settings: previous.settings,
              bindings: previous.bindings,
              ratingsImported: previous.ratingsImported,
              ratingModel: previous.ratingModel,
            })
        )
          return previous
        let revision = previous.revision
        try {
          for (
            let offset = 0;
            offset < Math.max(1, rows.length);
            offset += 1000
          ) {
            const last = offset + 1000 >= rows.length
            revision = await provider.favorites.save(
              revision,
              last
                ? metadata
                : {
                    version: 1,
                    settings: previous.settings,
                    bindings: previous.bindings,
                    ratingsImported: previous.ratingsImported,
                    ratingModel: previous.ratingModel,
                  },
              rows.slice(offset, offset + 1000)
            )
            if (!owns(provider, session))
              throw Error("Favorite library changed")
          }
          const saved = { ...next, revision }
          set({
            collection: saved,
            likedTrackIds: likedIds(saved),
            ratingsByTrackId: favoriteRatingIndex(
              saved,
              get().ratingsByTrackId
            ),
            error: null,
          })
          return saved
        } catch (error) {
          if (owns(provider, session))
            set({
              loaded: false,
              error: "Favorites could not be saved. Reload before syncing.",
            })
          throw error
        }
      })
    queue = job
    return job
  },
  async toggle(track, liked) {
    if (!/^[1-9]\d*$/.test(track.id) || !Number.isSafeInteger(Number(track.id)))
      throw Error("Only library songs can be saved to Liked Songs")
    await get().update((state) =>
      setFavorite(state, favoriteReference(track), liked, true)
    )
    requestSync()
  },
  async toggleEntry(id, liked) {
    await get().update((state) => {
      const item = state.entries[id]
      if (!item) throw Error("Favorite no longer exists")
      return {
        ...state,
        entries: {
          ...state.entries,
          [id]: { ...item, liked, explicit: true, changedAt: Date.now() },
        },
      }
    })
    requestSync()
  },
  async assignRecording(id, mbid) {
    const verified = recordingMbid(mbid.trim())
    if (!verified) throw Error("Enter a valid MusicBrainz recording ID")
    await get().update((state) => {
      const item = state.entries[id]
      if (!item) throw Error("Favorite no longer exists")
      if (item.recordingMbid || item.recordingMsid)
        throw Error("This favorite already has a recording identity")
      return {
        ...state,
        entries: {
          ...state.entries,
          [id]: { ...item, recordingMbid: verified },
        },
      }
    })
    requestSync()
  },
  async seedRatings(tracks) {
    if (get().collection.ratingsImported) return
    await get().update((state) => {
      if (state.ratingsImported) return state
      return seedFavoriteRatings(
        state,
        tracks
          .filter(
            (track) => (track.userRating ?? 0) >= state.settings.ratingThreshold
          )
          .map((track) => {
            const likedAt = Date.parse(track.lastRatedAt ?? "")
            return {
              ...favoriteReference(track),
              likedAt:
                Number.isFinite(likedAt) && likedAt > 0 ? likedAt : undefined,
            }
          })
      )
    })
    requestSync()
  },
  async ratingChanged(id, title, artist, rating, track) {
    const intent = favoriteRatingIntent(rating, id)
    await get().update((state) => {
      const row: FavoriteRecording =
        track?.id === id
          ? favoriteReference(track)
          : { key: `local:${id}`, localTrackId: id, title, artist }
      const next = setFavorite(state, row, (rating ?? 0) >= LIKED_RATING, true)
      const entries = { ...next.entries }
      for (const [key, entry] of Object.entries(entries))
        if (entry.localTrackIds.includes(id))
          entries[key] = { ...entry, rating: intent }
      return { ...next, entries }
    })
    requestSync()
    return intent
  },
  async confirmRating(intent, provider) {
    await get().update((state) => {
      let changed = false
      const entries = { ...state.entries }
      for (const [id, entry] of Object.entries(entries))
        if (entry.rating?.id === intent.id && !entry.rating.plexSaved) {
          entries[id] = {
            ...entry,
            rating: { ...entry.rating, plexSaved: true },
          }
          changed = true
        }
      return changed ? { ...state, entries } : state
    }, provider)
  },
  async configure(service, enabled, playlistId) {
    await get().update((state) => {
      const old = state.bindings[service]
      const changingDestination = !!playlistId && playlistId !== old?.playlistId
      if (changingDestination && (old?.creation || old?.pending))
        throw Error(
          "Recover the original Plex change before selecting another playlist"
        )
      const binding =
        old ??
        (service === "plex" && get().provider
          ? {
              account: providerPlaylistAccount(get().provider!),
              initialized: false,
            }
          : undefined)
      return {
        ...state,
        settings: { ...state.settings, [service]: enabled },
        bindings:
          changingDestination && binding
            ? {
                ...state.bindings,
                [service]: { ...binding, playlistId, initialized: false },
              }
            : state.bindings,
      }
    })
    requestSync()
  },
  async resetSync() {
    const provider = useProviderStore.getState().provider,
      session = provider?.playbackSession
    if (!provider?.favorites || !owns(provider, session))
      throw Error("Connect a library before resetting liked sync")
    if (
      get().resetting ||
      get().running ||
      (syncOwner?.provider === provider && syncOwner.session === session)
    )
      throw Error("Wait for the current liked sync to finish, then reset")
    matchEpoch++
    set({ resetting: true })
    const job = queue
      .catch(() => {})
      .then(async () => {
        await get().load(provider)
        if (!owns(provider, session)) throw Error("Favorite library changed")
        await provider.favorites!.reset(get().collection.revision)
        if (!owns(provider, session)) return
        set({ loaded: false, issues: {}, error: null })
        await get().load(provider)
      })
    queue = job
    try {
      await job
    } finally {
      if (owns(provider, session)) set({ resetting: false })
    }
  },
  async sync(options = {}) {
    const provider = useProviderStore.getState().provider,
      session = provider?.playbackSession
    if (
      !provider?.favorites ||
      get().resetting ||
      provider.isOffline ||
      (syncOwner?.provider === provider && syncOwner.session === session) ||
      !owns(provider, session)
    )
      return
    const run = { provider, session }
    syncOwner = run
    try {
      await get().load(provider)
    } catch (error) {
      if (syncOwner === run) syncOwner = undefined
      throw error
    }
    if (
      !owns(provider, session) ||
      get().resetting ||
      !Object.values(get().collection.settings).some((value) => value === true)
    ) {
      if (syncOwner === run) syncOwner = undefined
      return
    }
    const lbUser = useListenBrainzStore.getState().username,
      lfUser = useLastfmStore.getState().username
    let active = true
    const retireProvider = useProviderStore.subscribe((next, old) => {
      if (
        next.provider !== old.provider ||
        next.provider?.playbackSession !== session
      )
        active = false
    })
    const retireLb = useListenBrainzStore.subscribe((next, old) => {
      if (
        next.username !== old.username ||
        next.isAuthenticated !== old.isAuthenticated
      )
        active = false
    })
    const retireLf = useLastfmStore.subscribe((next, old) => {
      if (
        next.username !== old.username ||
        next.isAuthenticated !== old.isAuthenticated
      )
        active = false
    })
    const current = () =>
      active &&
      owns(provider, session) &&
      !provider.isOffline &&
      lbUser === useListenBrainzStore.getState().username &&
      lfUser === useLastfmStore.getState().username
    const native = provider.favorites,
      services: FavoriteSyncServices = {
        account: async (side) =>
          side === "plex"
            ? providerPlaylistAccount(provider)
            : favoritesRemote.account(side),
        page: favoritesRemote.page,
        peek: favoritesRemote.peek,
        set: favoritesRemote.set,
        plexCreate: async () =>
          (await provider.createPlaylist("Liked Songs", [])).id,
        plexRead: native.plexRead,
        plexMutate: native.plexMutate,
      }
    const runIssues: Partial<Record<FavoriteService, string>> = {}
    set({ running: true })
    const activity = beginActivity({ id: "favorite-sync", label: "Syncing liked songs", busy: true,
      action: { label: "Liked songs", href: "/collection/tracks" } }, current)
    try {
      await syncFavorites(
        {
          read: () => get().collection,
          update: (change) => {
            if (!current()) throw Error("Favorite owner changed")
            return get().update(change, provider)
          },
        },
        services,
        current,
        {
          ...options,
          onProgress: progress => {
            const service = progress.service === "lastfm" ? "Last.fm" : progress.service === "listenbrainz" ? "ListenBrainz" : "Plex"
            const verb = progress.stage === "reading" ? "Reading" : progress.stage === "verifying" ? "Verifying" : "Syncing"
            activity.update({ detail: `${verb} ${service} liked songs`, progress: progress.total == null ? undefined :
              { value: progress.completed, total: progress.total, label: progress.stage === "writing" ? "changes verified" : "liked songs read" } })
          },
          onIssue: (service, message) => {
            if (!current()) return
            runIssues[service] = message
            set((state) => ({
              issues: { ...state.issues, [service]: message },
            }))
          },
        }
      )
      if (current()) {
        set({ issues: runIssues })
      }
    } finally {
      activity.finish()
      active = false
      retireProvider()
      retireLb()
      retireLf()
      if (syncOwner === run) {
        syncOwner = undefined
        if (owns(provider, session)) set({ running: false })
      }
    }
  },
  async recoverPlex(id) {
    const provider = useProviderStore.getState().provider,
      session = provider?.playbackSession
    if (!provider?.favorites || provider.isOffline || !/^\d+$/.test(id))
      throw Error("Choose the inspected original Plex destination")
    const inspected = await provider.favorites.plexRead(id)
    if (
      !owns(provider, session) ||
      inspected.title !== "Liked Songs" ||
      inspected.items.length
    )
      throw Error("Choose the original empty Liked Songs playlist")
    await get().update(
      (state) => ({
        ...state,
        bindings: {
          ...state.bindings,
          plex: {
            ...state.bindings.plex!,
            playlistId: id,
            creation: undefined,
            initialized: false,
          },
        },
      }),
      provider
    )
    requestSync()
  },
  async matchMissing(force = false) {
    const provider = useProviderStore.getState().provider,
      session = provider?.playbackSession
    if (!provider || provider.isOffline || !get().loaded || get().resetting ||
      (matchOwner?.provider === provider && matchOwner.session === session && matchOwner.epoch === matchEpoch))
      return
    const epoch = matchEpoch
    const current = () =>
      owns(provider, session) && epoch === matchEpoch && !get().resetting
    const backlog = favoriteMatchBacklog(get().collection, force)
    const candidates = backlog.slice(0, 20)
    if (!candidates.length) return
    const run = { provider, session, epoch }
    matchOwner = run
    const progress = favoriteMatchingProgress(get().collection, backlog.length)
    let completed = 0
    const activity = beginActivity({ id: "favorite-matching", label: "Matching liked songs", busy: true,
      action: { label: "Liked songs", href: "/collection/tracks" },
      progress: { value: progress.checked, total: progress.total, label: "Liked songs checked" } }, current)
    try {
      for (const item of candidates) {
        if (!current()) return
        let localId = item.localTrackIds[0],
          mbid = item.recordingMbid
        try {
          if (!localId && item.title && item.artist) {
            const track = {
              id: item.id,
              title: item.title,
              artist: item.artist,
              album: item.album,
              durationMs: item.durationMs,
              recordingMbid: item.recordingMbid,
            }
            const found = await retrievePlaylistCandidates(
              provider,
              track,
              current
            )
            const match = matchTrack(track, found)
            if (match.status === "matched") localId = match.track.id
          }
          if (
            localId &&
            !mbid &&
            !item.recordingMsid &&
            provider.resolvePlaylistRecording &&
            get().collection.settings.listenbrainz
          ) {
            const track = await provider.getTrack(localId)
            const result = await provider.resolvePlaylistRecording({
              id: track.id,
              title: track.title,
              artist: favoriteReference(track).artist,
              album: track.albumName,
              durationMs: track.duration,
            })
            if (result.status === "verified") mbid = result.recordingMbid
          }
        } catch {
          /* Unresolved records remain retained and can be searched again. */
        }
        if (!current()) return
        await get().update((state) => {
          const latest = state.entries[item.id]
          if (!latest || !current()) return state
          const sameMatch =
            JSON.stringify(latest.localTrackIds) ===
            JSON.stringify(item.localTrackIds)
          return {
            ...state,
            entries: {
              ...state.entries,
              [item.id]: {
                ...latest,
                localTrackIds:
                  sameMatch && localId
                    ? [...new Set([localId, ...latest.localTrackIds])].slice(
                        0,
                        16
                      )
                    : latest.localTrackIds,
                recordingMbid:
                  latest.recordingMbid || (sameMatch ? mbid : undefined),
                matchCheckedAt: Date.now(),
              },
            },
          }
        }, provider)
        completed++
        activity.update({ detail: `${progress.checked + completed} of ${progress.total} liked songs checked`,
          progress: { value: progress.checked + completed, total: progress.total, label: "Liked songs checked" } })
      }
    } finally { activity.finish(); if (matchOwner === run) matchOwner = undefined }
  },
  async linkTrack(entryId, track) {
    await get().update((state) => {
      const item = state.entries[entryId]
      if (!item) throw Error("Favorite no longer exists")
      return {
        ...state,
        entries: {
          ...state.entries,
          [entryId]: {
            ...item,
            localTrackIds: [
              track.id,
              ...item.localTrackIds.filter((id) => id !== track.id),
            ].slice(0, 16),
            matchCheckedAt: undefined,
          },
        },
      }
    })
    requestSync()
  },
}))

backgroundActions("favorites", useFavoritesStore, ["sync", "matchMissing"])
