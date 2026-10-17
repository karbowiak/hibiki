import { createVerifiedPlaylistRefresh } from "../playlistSync/verifiedPlaylistRefresh"
import { create } from "zustand"
import { linkedPlaylistRepository } from "../playlistSync/linkedJournal"
import {
  canAdvancePartialWeekly,
  playlistContent,
  type LinkedPlaylist,
} from "../playlistSync/linked"
import type { MusicProvider } from "../providers/types"
import { useProviderStore } from "./providerStore"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import { providerPlaylistAccount } from "../playlistSync/provider"
import { samePlaylistIdentity } from "../playlistSync/types"
import type { PlaylistSnapshot } from "../playlistSync/types"
import {
  WeeklyArchiveCapacityError,
  newerWeeklyEdition,
  type WeeklyEdition,
} from "../playlistSync/weekly"
import {
  SyncCreationError,
  syncCreationJournal,
  syncCreationAccounts,
  type SyncCreationIntent,
} from "../playlistSync/creation"
interface State {
  activeCreationIds: Record<string, true>
  creationIntents: SyncCreationIntent[]
  unretainedCreations: Record<string, SyncCreationIntent>
  loadCreationIntents(): Promise<void>
  createSync(
    summary: PlaylistSnapshot,
    title: string,
    current?: () => boolean,
    weeklyEdition?: WeeklyEdition,
    direction?: "import" | "export"
  ): Promise<{ intent: SyncCreationIntent; link: LinkedPlaylist }>
  recoverCreation(
    id: string,
    destinationId?: string,
    current?: () => boolean,
    acknowledgedUnknown?: boolean
  ): Promise<{ intent: SyncCreationIntent; link: LinkedPlaylist }>
  retryMatching(id: string, current?: () => boolean): Promise<void>
  matchIncomplete(id: string): Promise<void>
  running: Record<string, true>
  syncNow(
    id: string,
    current?: () => boolean,
    options?: {
      maxSteps?: number
      onMutation?: () => void
      automatic?: boolean
    }
  ): Promise<LinkedPlaylist>
  bindWeeklyEdition(
    link: LinkedPlaylist,
    edition: WeeklyEdition,
    source: PlaylistSnapshot,
    library: PlaylistSnapshot
  ): Promise<LinkedPlaylist>
  holds: Record<string, true>
  hold(id: string, held: boolean): void
  links: LinkedPlaylist[]
  loading: boolean
  error: string | null
  checkedErrors: Record<string, string>
  load(): Promise<void>
  save(
    link: LinkedPlaylist,
    expectedRevision: number | null
  ): Promise<LinkedPlaylist>
  publish(link: LinkedPlaylist): void
  checkError(id: string, message: string | null): void
}
let version = 0
export const useLinkedPlaylistStore = create<State>((set, get) => ({
  activeCreationIds: {},
  creationIntents: [],
  unretainedCreations: {},
  async loadCreationIntents() {
    const rows = await syncCreationJournal.load()
    set({
      creationIntents: [
        ...rows.filter((item) => !get().unretainedCreations[item.id]),
        ...Object.values(get().unretainedCreations),
      ],
    })
  },
  async createSync(
    summary,
    title,
    ownsView = () => true,
    weeklyEdition,
    direction = "import"
  ) {
    const provider = useProviderStore.getState().provider
    if (!provider || provider.isOffline || get().error || !ownsView())
      throw Error("Connect the original library before creating sync")
    const scope = provider.cacheScope,
      session = provider.playbackSession,
      auth = useListenBrainzStore.getState()
    if (
      !auth.isAuthenticated ||
      !auth.username ||
      (direction === "import"
        ? auth.username !== summary.account.user
        : !samePlaylistIdentity(
            summary.account,
            providerPlaylistAccount(provider)
          ))
    )
      throw Error("ListenBrainz account changed")
    let active = true
    const unsubProvider = useProviderStore.subscribe((next, old) => {
      if (
        next.provider !== old.provider ||
        next.provider?.cacheScope !== scope ||
        next.provider?.playbackSession !== session
      )
        active = false
    })
    const unsubAuth = useListenBrainzStore.subscribe((next, old) => {
      if (
        next.username !== old.username ||
        next.isAuthenticated !== old.isAuthenticated
      )
        active = false
    })
    const current = () =>
      active &&
      useProviderStore.getState().provider === provider &&
      provider.cacheScope === scope &&
      provider.playbackSession === session &&
      !provider.isOffline &&
      !get().error &&
      useListenBrainzStore.getState().isAuthenticated &&
      useListenBrainzStore.getState().username === auth.username
    const admittedIds = new Set<string>()
    try {
      const { createLinkedSync } = await import("../playlistSync/creation")
      const { listenBrainzPlaylistAdapter, nativeListenBrainzPlaylists } =
        await import("../playlistSync/listenbrainz")
      const { providerPlaylistAdapter } =
        await import("../playlistSync/provider")
      const lbAccount =
        direction === "export"
          ? await nativeListenBrainzPlaylists.account()
          : summary.account
      if (!current() || lbAccount.user !== auth.username)
        throw Error("Creation account changed")
      const library = providerPlaylistAdapter(provider),
        remote = listenBrainzPlaylistAdapter(lbAccount)
      const result = await createLinkedSync(
        summary.id,
        title,
        {
          source: direction === "export" ? library : remote,
          target: direction === "export" ? remote : library,
          direction,
          journal: {
            load: syncCreationJournal.load,
            save: async (intent) => {
              admittedIds.add(intent.id)
              set((state) => ({
                activeCreationIds: {
                  ...state.activeCreationIds,
                  [intent.id]: true,
                },
              }))
              await syncCreationJournal.save(intent)
              set((state) => ({
                creationIntents: [
                  ...state.creationIntents.filter(
                    (item) => item.id !== intent.id
                  ),
                  intent,
                ],
              }))
            },
          },
          links: {
            load: linkedPlaylistRepository.load,
            save: (link, revision) => get().save(link, revision),
          },
          current,
          admissionCurrent: ownsView,
        },
        weeklyEdition
      )
      if (current() && result.link.incomplete)
        void get()
          .matchIncomplete(result.link.id)
          .catch(() => {})
      return result
    } catch (error) {
      if (error instanceof SyncCreationError) {
        set((state) => ({
          creationIntents: [
            ...state.creationIntents.filter(
              (item) => item.id !== error.intent.id
            ),
            error.intent,
          ],
          ...(error.unretained
            ? {
                unretainedCreations: {
                  ...state.unretainedCreations,
                  [error.intent.id]: error.intent,
                },
                error:
                  "Playlist creation recovery is not saved. Retry retaining its receipt before any further sync writes.",
              }
            : {}),
        }))
      }
      throw error
    } finally {
      active = false
      unsubProvider()
      unsubAuth()
      set((state) => ({
        activeCreationIds: Object.fromEntries(
          Object.entries(state.activeCreationIds).filter(
            ([id]) => !admittedIds.has(id)
          )
        ),
      }))
    }
  },
  async recoverCreation(
    id,
    destinationId,
    ownsView = () => true,
    acknowledgedUnknown = false
  ) {
    if (get().activeCreationIds[id]) throw Error("Creation is still running")
    const intent =
      get().unretainedCreations[id] ??
      get().creationIntents.find((item) => item.id === id) ??
      (await syncCreationJournal.load()).find((item) => item.id === id)
    const provider = useProviderStore.getState().provider
    const accounts = intent ? syncCreationAccounts(intent) : undefined
    if (
      !intent ||
      !provider ||
      provider.isOffline ||
      !ownsView() ||
      !samePlaylistIdentity(
        providerPlaylistAccount(provider),
        accounts!.library
      ) ||
      useListenBrainzStore.getState().username !== accounts!.listenbrainz.user
    )
      throw Error("Recover this creation in its original accounts")
    if (!intent.destinationId && (!destinationId || !acknowledgedUnknown))
      throw Error(
        "Inspect and explicitly acknowledge the original destination before selecting an unknown creation"
      )
    if (
      intent.destinationId &&
      destinationId &&
      intent.destinationId !== destinationId
    )
      throw Error("Known creation destination cannot change")
    const scope = provider.cacheScope,
      session = provider.playbackSession,
      username = accounts!.listenbrainz.user
    let active = true
    const unsubscribeProvider = useProviderStore.subscribe((next, old) => {
      if (
        next.provider !== old.provider ||
        next.provider?.cacheScope !== scope ||
        next.provider?.playbackSession !== session
      )
        active = false
    })
    const unsubscribeAuth = useListenBrainzStore.subscribe((next, old) => {
      if (
        next.username !== old.username ||
        next.isAuthenticated !== old.isAuthenticated
      )
        active = false
    })
    const current = () =>
      active &&
      ownsView() &&
      useProviderStore.getState().provider === provider &&
      provider.cacheScope === scope &&
      provider.playbackSession === session &&
      !provider.isOffline &&
      useListenBrainzStore.getState().username === username &&
      useListenBrainzStore.getState().isAuthenticated
    set((state) => ({
      activeCreationIds: { ...state.activeCreationIds, [id]: true },
    }))
    try {
      const { reconcileSyncCreation } = await import("../playlistSync/creation")
      const { listenBrainzPlaylistAdapter, nativeListenBrainzPlaylists } =
        await import("../playlistSync/listenbrainz")
      const { providerPlaylistAdapter } =
        await import("../playlistSync/provider")
      const lbAccount = await nativeListenBrainzPlaylists.account()
      if (
        !current() ||
        !samePlaylistIdentity(lbAccount, accounts!.listenbrainz)
      )
        throw Error("Creation account changed")
      const library = providerPlaylistAdapter(provider),
        remote = listenBrainzPlaylistAdapter(lbAccount)
      const target = intent.direction === "export" ? remote : library
      let candidateId = intent.destinationId ?? destinationId!
      if (intent.direction === "export") {
        const { playlistId } = await import("../playlistSync/jspf")
        candidateId = playlistId(candidateId)
      }
      if (!intent.destinationId) {
        const inspected = await target.read(candidateId)
        if (
          !current() ||
          inspected.id !== candidateId ||
          !samePlaylistIdentity(inspected.account, intent.target) ||
          inspected.title !== intent.title ||
          inspected.items.length
        )
          throw Error(
            "Inspect the expected empty destination before adopting its ID"
          )
      }
      const recoveredIntent = {
        ...intent,
        destinationId: candidateId,
      }
      await syncCreationJournal.save(recoveredIntent)
      set((state) => ({
        unretainedCreations: Object.fromEntries(
          Object.entries(state.unretainedCreations).filter(
            ([key]) => key !== id
          )
        ),
        error:
          state.error ===
            "Playlist creation recovery is not saved. Retry retaining its receipt before any further sync writes." &&
          Object.keys(state.unretainedCreations).every((key) => key === id)
            ? null
            : state.error,
      }))
      const result = await reconcileSyncCreation(recoveredIntent, {
        source: intent.direction === "export" ? library : remote,
        target,
        journal: syncCreationJournal,
        links: {
          load: linkedPlaylistRepository.load,
          save: (link, revision) => get().save(link, revision),
        },
        current,
      })
      await get().loadCreationIntents()
      if (current() && result.link.incomplete)
        void get()
          .matchIncomplete(result.link.id)
          .catch(() => {})
      return result
    } finally {
      active = false
      unsubscribeProvider()
      unsubscribeAuth()
      set((state) => ({
        activeCreationIds: Object.fromEntries(
          Object.entries(state.activeCreationIds).filter(([key]) => key !== id)
        ),
      }))
    }
  },
  async retryMatching(id, ownsView = () => true) {
    const provider = useProviderStore.getState().provider,
      auth = useListenBrainzStore.getState()
    if (
      !provider ||
      provider.isOffline ||
      !auth.isAuthenticated ||
      !auth.username ||
      get().error ||
      get().holds[id] ||
      get().running[id] ||
      !ownsView()
    )
      throw Error(
        "Resolve connection or recovery issues before retrying matching"
      )
    const scope = provider.cacheScope,
      session = provider.playbackSession,
      username = auth.username
    let active = true,
      resumed = false
    const unsubscribeProvider = useProviderStore.subscribe((next, old) => {
      if (
        next.provider !== old.provider ||
        next.provider?.cacheScope !== scope ||
        next.provider?.playbackSession !== session
      )
        active = false
    })
    const unsubscribeAuth = useListenBrainzStore.subscribe((next, old) => {
      if (
        next.username !== old.username ||
        next.isAuthenticated !== old.isAuthenticated
      )
        active = false
    })
    const current = () =>
      active &&
      useProviderStore.getState().provider === provider &&
      provider.cacheScope === scope &&
      provider.playbackSession === session &&
      !provider.isOffline &&
      useListenBrainzStore.getState().username === username &&
      useListenBrainzStore.getState().isAuthenticated &&
      !get().error &&
      !get().holds[id]
    set((state) => ({ running: { ...state.running, [id]: true } }))
    try {
      const rows = await linkedPlaylistRepository.load()
      if (!current() || !ownsView()) throw Error("Matching owner changed")
      const link = rows.find((item) => item.id === id)
      if (
        !link ||
        link.listenbrainz.user !== username ||
        !samePlaylistIdentity(link.library, providerPlaylistAccount(provider))
      )
        throw Error("Retry matching in the original accounts")
      const { resumeInitialMatching } =
        await import("../playlistSync/initialMatching")
      if (!current() || !ownsView()) throw Error("Matching owner changed")
      await get().save(resumeInitialMatching(link), link.revision)
      resumed = current()
      if (resumed) get().checkError(id, null)
    } finally {
      const launch = resumed && current()
      active = false
      unsubscribeProvider()
      unsubscribeAuth()
      set((state) => ({
        running: Object.fromEntries(
          Object.entries(state.running).filter(([key]) => key !== id)
        ),
      }))
      if (launch)
        void get()
          .matchIncomplete(id)
          .catch(() => {})
    }
  },
  async matchIncomplete(id) {
    const provider = useProviderStore.getState().provider
    if (
      !provider ||
      provider.isOffline ||
      get().error ||
      get().holds[id] ||
      get().running[id]
    )
      return
    const scope = provider.cacheScope,
      session = provider.playbackSession,
      username = useListenBrainzStore.getState().username
    const link = get().links.find((item) => item.id === id)
    if (
      !link ||
      link.listenbrainz.user !== username ||
      !samePlaylistIdentity(link.library, providerPlaylistAccount(provider))
    )
      return
    let active = true
    const unsubscribe = useProviderStore.subscribe((next, old) => {
      if (
        next.provider !== old.provider ||
        next.provider?.cacheScope !== scope ||
        next.provider?.playbackSession !== session
      )
        active = false
    })
    const unsubscribeAuth = useListenBrainzStore.subscribe((next, old) => {
      if (
        next.username !== old.username ||
        next.isAuthenticated !== old.isAuthenticated
      )
        active = false
    })
    const current = () =>
      active &&
      useProviderStore.getState().provider === provider &&
      provider.cacheScope === scope &&
      provider.playbackSession === session &&
      !provider.isOffline &&
      useListenBrainzStore.getState().username === username &&
      useListenBrainzStore.getState().isAuthenticated &&
      !get().error &&
      !get().holds[id]
    set((state) => ({ running: { ...state.running, [id]: true } }))
    try {
      const { matchInitialSync } =
        await import("../playlistSync/initialMatching")
      await matchInitialSync(
        id,
        provider,
        {
          load: linkedPlaylistRepository.load,
          save: (link, revision) => get().save(link, revision),
        },
        current
      )
      if (current()) get().checkError(id, null)
    } catch {
      if (current())
        get().checkError(
          id,
          "Background matching paused. Every source song is retained; review the playlist before continuing."
        )
    } finally {
      active = false
      unsubscribe()
      unsubscribeAuth()
      set((state) => ({
        running: Object.fromEntries(
          Object.entries(state.running).filter(([key]) => key !== id)
        ),
      }))
    }
  },
  running: {},
  async syncNow(id, ownsView = () => true, options = {}) {
    const provider = useProviderStore.getState().provider,
      auth = useListenBrainzStore.getState()
    if (
      !provider ||
      provider.isOffline ||
      !auth.isAuthenticated ||
      !auth.username ||
      get().error ||
      get().holds[id]
    )
      throw Error(
        "Review the connection and local recovery settings before syncing"
      )
    if (get().running[id]) throw Error("This playlist is already syncing")
    const scope = provider.cacheScope,
      session = provider.playbackSession,
      username = auth.username
    let active = true
    const retireProvider = useProviderStore.subscribe((next, old) => {
      if (
        next.provider !== old.provider ||
        next.provider?.cacheScope !== scope ||
        next.provider?.playbackSession !== session
      )
        active = false
    })
    const retireAuth = useListenBrainzStore.subscribe((next, old) => {
      if (
        next.username !== old.username ||
        next.isAuthenticated !== old.isAuthenticated
      )
        active = false
    })
    const current = () =>
      active &&
      ownsView() &&
      useProviderStore.getState().provider === provider &&
      provider.cacheScope === scope &&
      provider.playbackSession === session &&
      !provider.isOffline &&
      useListenBrainzStore.getState().username === username &&
      useListenBrainzStore.getState().isAuthenticated &&
      !get().error &&
      !get().holds[id]
    set((state) => ({ running: { ...state.running, [id]: true } }))
    try {
      await get().load()
      if (!current()) throw Error("Playlist sync session changed")
      let link = get().links.find((item) => item.id === id)
      if (
        !link ||
        !samePlaylistIdentity(
          link.library,
          providerPlaylistAccount(provider)
        ) ||
        link.listenbrainz.user !== username
      )
        throw Error("This link belongs to another account or library")
      if (
        !link.enabled ||
        (link.paused && !(options.automatic && canAdvancePartialWeekly(link)))
      )
        throw Error("Configure or review this paused link before syncing")
      const { linkedSyncServices } =
        await import("../playlistSync/linkedServices")
      const { checkLinkedPlaylist } =
        await import("../playlistSync/linkedExecution")
      const services = await linkedSyncServices(provider, link, current)
      if (!current()) throw Error("Playlist sync session changed")
      if (
        link.weeklySource &&
        !link.job &&
        (!link.incomplete ||
          (options.automatic && canAdvancePartialWeekly(link)))
      ) {
        if (!services.latestWeekly)
          throw Error("This connection cannot verify the latest weekly source")
        const channel = await services.latestWeekly(link.weeklySource.family)
        if (!current()) throw Error("Weekly source owner changed")
        const selectedReviewedEdition =
          !options.automatic &&
          channel.editions.some(
            (edition) =>
              edition.playlistId === link!.weeklySource!.edition.playlistId &&
              edition.createdAt === link!.weeklySource!.edition.createdAt
          )
        if (
          (channel.status !== "ready" || !channel.latest) &&
          !selectedReviewedEdition
        )
          return get().save(
            {
              ...link,
              paused: true,
              state: "conflict",
              message:
                "The latest weekly edition is unavailable or ambiguous. Review the channel and choose an edition before syncing.",
            },
            link.revision
          )
        if (
          channel.latest &&
          (link.weeklySource.lastSyncedEditionId ===
            link.weeklySource.edition.playlistId ||
            canAdvancePartialWeekly(link)) &&
          channel.latest.playlistId !== link.listenbrainzPlaylistId &&
          newerWeeklyEdition(channel.latest, link.weeklySource.edition)
        ) {
          const [source, library] = await Promise.all([
            services.listenbrainz.read(channel.latest.playlistId),
            services.library.read(link.libraryPlaylistId),
          ])
          if (!current()) throw Error("Weekly source owner changed")
          if (
            source.id !== channel.latest.playlistId ||
            playlistContent(library) !==
              playlistContent(link.baseline.library) ||
            (library.description ?? "") !==
              (link.baseline.library.description ?? "")
          )
            return get().save(
              {
                ...link,
                paused: true,
                state: "conflict",
                message:
                  "The library or weekly source changed before edition admission. Review the playlist before continuing.",
              },
              link.revision
            )
          link = await get().bindWeeklyEdition(
            link,
            channel.latest,
            source,
            library
          )
          if (!current()) throw Error("Weekly source owner changed")
        }
        if (
          options.automatic &&
          (canAdvancePartialWeekly(link) ||
            link.weeklySource?.lastSyncedEditionId ===
              link.listenbrainzPlaylistId)
        )
          return link
      }
      services.repository = {
        load: services.repository.load,
        save: (value, revision) => get().save(value, revision),
      }
      const notifyVerified = createVerifiedPlaylistRefresh(provider, current)
      for (const side of ["library", "listenbrainz"] as const) {
        const mutate = services[side].mutate
        services[side].mutate = async (...args) => {
          options.onMutation?.()
          const result = await mutate(...args)
          if (side === "library" && current()) notifyVerified(result)
          return result
        }
        const describe = services[side].describe
        if (describe)
          services[side].describe = async (...args) => {
            options.onMutation?.()
            const result = await describe(...args)
            if (side === "library" && current()) notifyVerified(result)
            return result
          }
      }
      const result = await checkLinkedPlaylist(
        link,
        services,
        Math.max(0, Math.min(20, options.maxSteps ?? 20))
      )
      if (current()) {
        get().publish(result)
        get().checkError(id, null)
      }
      return result
    } catch (error) {
      if (current())
        get().checkError(
          id,
          error instanceof WeeklyArchiveCapacityError
            ? error.message
            : "Sync could not be confirmed. Review the link and retained recovery state before trying again."
        )
      throw error
    } finally {
      const resume =
        current() &&
        !!get().links.find(
          (link) =>
            link.id === id &&
            link.incomplete &&
            !link.incomplete.matchingDone &&
            !link.paused
        )
      active = false
      retireProvider()
      retireAuth()
      set((state) => ({
        running: Object.fromEntries(
          Object.entries(state.running).filter(([key]) => key !== id)
        ),
      }))
      if (resume)
        void get()
          .matchIncomplete(id)
          .catch(() => {})
    }
  },
  async bindWeeklyEdition(link, edition, source, library) {
    if (
      get().error ||
      get().holds[link.id] ||
      !linkedPlaylistRepository.bindWeeklyEdition
    )
      throw Error(
        "Review local recovery settings before binding a weekly edition"
      )
    try {
      const saved = await linkedPlaylistRepository.bindWeeklyEdition(
        link,
        link.revision,
        edition,
        source,
        library
      )
      version++
      get().publish(saved)
      return saved
    } catch (error) {
      if (error instanceof WeeklyArchiveCapacityError) {
        get().checkError(link.id, error.message)
        throw error
      }
      set({
        error:
          "The weekly source could not be retained. Reload recovery settings before syncing.",
      })
      throw error
    }
  },
  holds: {},
  hold: (id, held) =>
    set((s) => ({
      holds: held
        ? { ...s.holds, [id]: true }
        : Object.fromEntries(
            Object.entries(s.holds).filter(([key]) => key !== id)
          ),
    })),
  links: [],
  loading: false,
  error: null,
  checkedErrors: {},
  load: async () => {
    const revision = ++version
    set({ loading: true })
    try {
      const links = await linkedPlaylistRepository.load()
      if (version === revision) set({ links, loading: false, error: null })
    } catch {
      if (version === revision)
        set({
          loading: false,
          error:
            "Linked playlist recovery settings could not be read. Sync is paused; retry local storage before continuing.",
        })
    }
  },
  save: async (link, expectedRevision) => {
    try {
      const saved = await linkedPlaylistRepository.save(link, expectedRevision)
      version++
      get().publish(saved)
      return saved
    } catch (error) {
      set({
        error:
          "Linked playlist changes could not be retained. Sync is paused. Reload local recovery settings before continuing.",
      })
      throw error
    }
  },
  publish: (link) =>
    set((s) => ({
      links: [...s.links.filter((item) => item.id !== link.id), link],
    })),
  checkError: (id, message) =>
    set((s) => ({
      checkedErrors: message
        ? { ...s.checkedErrors, [id]: message }
        : Object.fromEntries(
            Object.entries(s.checkedErrors).filter(([key]) => key !== id)
          ),
    })),
}))
/** Scoped playlist entrypoints never expose another library's retained links. */
export function linksForPlaylist(
  provider: MusicProvider | null,
  playlistId: string
): LinkedPlaylist[] {
  if (!provider) return []
  try {
    const owner = providerPlaylistAccount(provider)
    return useLinkedPlaylistStore
      .getState()
      .links.filter(
        (link) =>
          link.libraryPlaylistId === playlistId &&
          samePlaylistIdentity(link.library, owner)
      )
  } catch {
    return []
  }
}
