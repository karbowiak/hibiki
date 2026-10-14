import { create } from "zustand"
import { useProviderStore } from "./providerStore"
import { useLastfmStore } from "../metadata/lastfm/authStore"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import { useNotificationCenterStore } from "./notificationCenterStore"
import {
  emptyFavorites,
  setFavorite,
  findFavorite,
  seedFavoriteRatings,
} from "../favorites/model"
import {
  favoriteReference,
  type FavoriteState,
  type FavoriteService,
  type FavoriteMetadata,
  type FavoriteRecording,
} from "../favorites/types"
import { favoritesRemote } from "../favorites/native"
import { syncFavorites, type FavoriteSyncServices } from "../favorites/sync"
import { validFavorite, validFavoriteMetadata } from "../favorites/validation"
import { providerPlaylistAccount } from "../playlistSync/provider"
import { retrievePlaylistCandidates } from "../playlistSync/candidateRetrieval"
import { matchTrack, recordingMbid } from "../playlistSync/matching"
import type { MusicProvider } from "../providers/types"
import type { MusicTrack } from "../types/music"
interface State {
  collection: FavoriteState
  likedTrackIds: Set<string>
  provider: MusicProvider | null
  session: unknown
  loaded: boolean
  loading: boolean
  running: boolean
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
    rating: number | null
  ): Promise<void>
  configure(
    service: FavoriteService,
    enabled: boolean,
    playlistId?: string
  ): Promise<void>
  sync(options?: { retryUnknown?: boolean }): Promise<void>
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
  provider: null,
  session: null,
  loaded: false,
  loading: false,
  running: false,
  error: null,
  issues: {},
  async load(provider = useProviderStore.getState().provider) {
    if (!provider?.favorites) {
      set({
        provider: null,
        session: null,
        collection: emptyFavorites(),
        likedTrackIds: new Set(),
        loaded: false,
        loading: false,
        running: false,
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
      error: null,
      collection: emptyFavorites(),
      likedTrackIds: new Set(),
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
        const collection = {
          ...profile.metadata,
          entries,
          revision: profile.revision,
        }
        if (owns(provider, session))
          set({
            collection,
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
  },
  async ratingChanged(id, title, artist, rating) {
    await get().update((state) => {
      const row: FavoriteRecording = {
        key: `local:${id}`,
        localTrackId: id,
        title,
        artist,
      }
      const liked = (rating ?? 0) >= state.settings.ratingThreshold
      if (!liked && !findFavorite(state, row)) return state
      return setFavorite(state, row, liked, false)
    })
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
  },
  async sync(options = {}) {
    const provider = useProviderStore.getState().provider,
      session = provider?.playbackSession
    if (
      !provider?.favorites ||
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
    set({ running: true, issues: {} })
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
          onIssue: (service, message) => {
            if (!current()) return
            set((state) => ({
              issues: { ...state.issues, [service]: message },
            }))
            useNotificationCenterStore.getState().notify({
              id: `favorites.${service}`,
              eventKey: JSON.stringify([provider.cacheScope, service, message]),
              title: "Liked Songs sync needs attention",
              message:
                "Your likes are saved in Hibiki. Open Liked Songs → Sync to review this connection.",
              severity: "warning",
              persistent: false,
            })
          },
        }
      )
      if (current()) await get().matchMissing()
    } finally {
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
  },
  async matchMissing(force = false) {
    const provider = useProviderStore.getState().provider,
      session = provider?.playbackSession
    if (!provider || provider.isOffline || !get().loaded) return
    const candidates = Object.values(get().collection.entries)
      .filter(
        (item) =>
          item.liked &&
          (force ||
            !item.matchCheckedAt ||
            Date.now() - item.matchCheckedAt > 86400000) &&
          (!item.localTrackIds.length ||
            (get().collection.settings.listenbrainz &&
              !item.recordingMbid &&
              !item.recordingMsid))
      )
      .sort((a, b) => (a.matchCheckedAt ?? 0) - (b.matchCheckedAt ?? 0))
      .slice(0, 20)
    for (const item of candidates) {
      if (!owns(provider, session)) return
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
          const found = await retrievePlaylistCandidates(provider, track, () =>
            owns(provider, session)
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
            artist: track.artistName,
            album: track.albumName,
            durationMs: track.duration,
          })
          if (result.status === "verified") mbid = result.recordingMbid
        }
      } catch {
        /* Unresolved records remain retained and can be searched again. */
      }
      if (!owns(provider, session)) return
      await get().update((state) => {
        const latest = state.entries[item.id]
        if (!latest) return state
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
    }
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
  },
}))
