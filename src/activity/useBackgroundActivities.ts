import { useEffect, useMemo, useRef, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useShallow } from "zustand/react/shallow"
import { useProviderStore } from "../stores/providerStore"
import { useCatalogueStore } from "../offline/catalogueStore"
import { useMixedPlaylistStore } from "../stores/mixedPlaylistStore"
import { useLinkedPlaylistStore } from "../stores/linkedPlaylistStore"
import { useFavoritesStore } from "../stores/favoritesStore"
import type { FavoriteService } from "../favorites/types"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import { useYoutubeMusicRatingsStore } from "../backends/ytmusic/ratings"
import { providerPlaylistAccount } from "../playlistSync/provider"
import { samePlaylistIdentity } from "../playlistSync/types"
import { syncCreationAccounts } from "../playlistSync/creation"
import { useActivityStore } from "./store"
import {
  monitorActivity,
  refreshNativeActivity,
  subscribeNativeActivity,
} from "./native"
import {
  downloadActivity,
  matchingIndexActivity,
  mixedPlaylistActivity,
  ownsPlaylistActivity,
  backgroundJobActivities,
  combineBackgroundActivities,
  type BackgroundQueueStatus,
  type Activity,
  type DownloadActivitySummary,
} from "./model"

export function useBackgroundActivities(open: boolean): Activity[] {
  const opened = useRef(open)
  opened.current = open
  const [queueActivities, setQueueActivities] = useState<Activity[]>([])
  useEffect(() => {
    if (!isTauri()) return
    const monitor = monitorActivity({
      current: () => true,
      minIntervalMs: 500,
      read: () => invoke<BackgroundQueueStatus>("background_queue_status"),
      publish: (value) => setQueueActivities(backgroundJobActivities(value)),
      interval: (value) =>
        opened.current || value?.running || value?.pending ? 3000 : 15000,
    })
    const unsubscribe = subscribeNativeActivity(() => monitor.offer())
    let active = true
    const unlisten = listen("background://changed", () => monitor.offer())
      .then((stop) => {
        if (!active) stop()
        return stop
      })
      .catch(() => () => {})
    monitor.offer()
    return () => {
      active = false
      void unlisten.then((stop) => stop())
      unsubscribe()
      monitor.stop()
    }
  }, [])
  useEffect(() => {
    if (open) refreshNativeActivity()
  }, [open])
  const { provider, scope, session, offline } = useProviderStore(
    useShallow((state) => ({
      provider: state.provider,
      scope: state.provider?.cacheScope,
      session: state.provider?.playbackSession,
      offline: !!state.provider?.isOffline,
    }))
  )
  const context = useCatalogueStore((state) => state.context)
  const youtube = useYoutubeMusicDiscoveryStore(
    useShallow((state) => ({
      connected: state.connected,
      accountId: state.accountId,
      revision: state.revision,
    }))
  )
  const mixed = useMixedPlaylistStore(
    useShallow((state) => ({
      playlists: state.playlists,
      running: state.running,
      phases: state.phases,
    }))
  )
  const linked = useLinkedPlaylistStore(
    useShallow((state) => ({
      links: state.links,
      running: state.running,
      checkedErrors: state.checkedErrors,
      creationIntents: state.creationIntents,
      activeCreationIds: state.activeCreationIds,
    }))
  )
  const auth = useListenBrainzStore(
    useShallow((state) => ({
      username: state.username,
      authenticated: state.isAuthenticated,
    }))
  )
  const favorites = useFavoritesStore(
    useShallow((state) => ({
      provider: state.provider,
      session: state.session,
      running: state.running,
      resetting: state.resetting,
      pending: Object.entries(state.collection.bindings).filter(([service, binding]) => state.collection.settings[service as FavoriteService] && (binding?.pending || binding?.creation)).map(([service]) => service === "lastfm" ? "Last.fm" : service === "listenbrainz" ? "ListenBrainz" : "Plex").join(" and "),
    }))
  )
  const ratings = useYoutubeMusicRatingsStore(
    useShallow((state) => ({ owner: state.owner, syncing: state.syncing }))
  )
  const jobs = useActivityStore((state) => state.jobs)
  const [native, setNative] = useState<{
    provider: typeof provider
    session: unknown
    revision: number
    scope: string
    activities: Activity[]
  } | null>(null)
  useEffect(() => {
    setNative(null)
    if (!isTauri() || !provider || !context || scope !== context.cacheScope)
      return
    const current = () => {
      const latest = useProviderStore.getState().provider,
        active = useCatalogueStore.getState().context
      return (
        provider === latest &&
        latest.playbackSession === session &&
        latest.cacheScope === scope &&
        active?.cacheScope === scope &&
        active.connectionRevision === context.connectionRevision
      )
    }
    let previous: Activity[] = []
    const monitor = monitorActivity({
      current,
      read: async () => {
        const results = await Promise.allSettled([
          invoke<DownloadActivitySummary>("download_activity", { context }),
          provider.matchingIndexStatus
            ? provider.matchingIndexStatus()
            : Promise.resolve(null),
        ])
        const activities: Activity[] = []
        if (results[0].status === "fulfilled" && results[0].value) {
          const row = downloadActivity(results[0].value, !!provider.isOffline)
          if (row) activities.push(row)
        }
        if (results[1].status === "fulfilled" && results[1].value) {
          const row = matchingIndexActivity({
            ...results[1].value,
            paused: results[1].value.paused || !!provider.isOffline,
          })
          if (row) activities.push(row)
        }
        // A failed status read is not evidence that an active operation finished.
        for (const [index, id] of ["downloads", "matching-index"].entries()) {
          const old = previous.find((row) => row.id === id)
          if (results[index].status === "rejected" && old)
            activities.push({
              ...old,
              busy: false,
              state: "waiting",
              detail:
                "Progress temporarily unavailable · checking again automatically",
            })
        }
        previous = activities
        return activities
      },
      publish: (activities) =>
        setNative({
          provider,
          session,
          revision: context.connectionRevision,
          scope,
          activities,
        }),
      interval: (activities) =>
        opened.current || activities?.some((row) => row.busy) ? 3000 : 15000,
    })
    const unsubscribe = subscribeNativeActivity(() => monitor.offer())
    monitor.offer()
    return () => {
      monitor.stop()
      unsubscribe()
    }
  }, [
    provider,
    session,
    scope,
    context?.connectionRevision,
    context?.cacheScope,
    offline,
  ])

  return useMemo(() => {
    const activities: Activity[] = []
    const owners = {
      plex: scope,
      ytmusic: youtube.connected ? youtube.accountId : undefined,
    }
    for (const playlist of mixed.playlists)
      if (ownsPlaylistActivity(playlist, owners)) {
        const row = mixedPlaylistActivity(
          playlist,
          !!mixed.running[playlist.id],
          mixed.phases[playlist.id],
          offline
        )
        if (row) activities.push(row)
      }
    if (provider && scope && auth.authenticated) {
      const account = providerPlaylistAccount(provider)
      for (const link of linked.links) {
        if (
          link.listenbrainz.user !== auth.username ||
          !samePlaylistIdentity(link.library, account)
        )
          continue
        const busy = !!linked.running[link.id],
          incomplete = link.incomplete
        const review =
          ["conflict", "unknown", "error"].includes(link.state) ||
          !!linked.checkedErrors[link.id]
        const pending = incomplete && !incomplete.matchingDone && link.enabled
        if (!busy && !review && !pending && !link.job) continue
        activities.push({
          id: `linked:${link.id}`,
          label: link.baseline.library.title,
          detail: [
            busy
              ? incomplete && !incomplete.matchingDone
                ? "Matching ListenBrainz songs"
                : "Syncing ListenBrainz"
              : review
                ? "Sync needs review"
                : link.paused || offline
                  ? "Sync paused"
                  : "Sync queued",
            ...(incomplete
              ? [
                  `${incomplete.matchingCursor.toLocaleString()} of ${incomplete.total.toLocaleString()} checked · ${incomplete.matchedCount.toLocaleString()} matched`,
                ]
              : []),
            ...(link.job
              ? [`${link.job.completedSteps.toLocaleString()} changes verified`]
              : []),
          ].join("\n"),
          busy,
          state: busy
            ? undefined
            : review || link.paused || offline
              ? "paused"
              : "waiting",
          action: {
            label: "Open playlist",
            href: `/playlist/${encodeURIComponent(link.libraryPlaylistId)}`,
          },
        })
      }
      for (const intent of linked.creationIntents) {
        const owner = syncCreationAccounts(intent),
          busy = !!linked.activeCreationIds[intent.id]
        if (
          !samePlaylistIdentity(owner.library, account) ||
          owner.listenbrainz.user !== auth.username ||
          (!busy && ["linked", "cancelled"].includes(intent.state))
        )
          continue
        activities.push({
          id: `creation:${intent.id}`,
          label: intent.title,
          detail: busy
            ? "Creating linked playlist"
            : "Playlist creation needs review",
          busy,
          state: busy ? undefined : "paused",
          action: { label: "Review playlists", href: "/collection/playlists" },
        })
      }
    }
    if (
      favorites.provider === provider &&
      favorites.session === session &&
      (favorites.running || favorites.resetting || favorites.pending)
    )
      activities.push({
        id: "favorites",
        label: favorites.resetting
          ? "Resetting favorite sync"
          : favorites.running ? "Syncing liked songs" : "Liked-song sync needs review",
        busy: favorites.running || favorites.resetting,
        state: favorites.running || favorites.resetting ? undefined : "paused",
        detail: !favorites.running && favorites.pending ? `Unverified saved changes on ${favorites.pending}.` : undefined,
        action: { label: "Liked songs", href: "/collection/tracks" },
      })
    if (youtube.connected && ratings.owner === youtube.accountId) {
      const total = Object.values(ratings.syncing).filter((job) =>
        job.current()
      ).length
      if (total)
        activities.push({
          id: "ytmusic-ratings",
          label: "Syncing song ratings",
          detail: `${total.toLocaleString()} ${total === 1 ? "song" : "songs"} · YTM and connected services`,
          busy: true,
        })
    }
    for (const job of Object.values(jobs))
      if (job.current())
        activities.push(
          job.activity.id === "favorite-sync"
            ? { ...job.activity, id: "favorites" }
            : job.activity
        )
    if (
      native?.provider === provider &&
      native.session === session &&
      native.scope === scope &&
      native.revision === context?.connectionRevision
    )
      activities.push(...native.activities)
    // Keep rows in place as phases change; moving them on every checkpoint makes progress hard to follow.
    return combineBackgroundActivities(activities, queueActivities)
  }, [
    provider,
    scope,
    session,
    offline,
    youtube,
    mixed,
    linked,
    auth,
    favorites,
    ratings,
    jobs,
    queueActivities,
    native,
    context?.connectionRevision,
  ])
}
