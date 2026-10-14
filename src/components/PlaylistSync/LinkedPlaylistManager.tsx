import { useEffect, useRef, useState, useId } from "react"
import { PlaylistSyncFrame, navigateSyncTabs } from "./PlaylistSyncFrame"
import { VerifiedRecordingsAction } from "./VerifiedRecordingsAction"
import { snapshotRevision } from "../../playlistSync/planner"
import { PlaylistCopyReceipts } from "./PlaylistCopyReceipts"
import { OccurrenceResolver } from "./PlaylistCopyDialog"
import { linkedMatchEvidenceLabel } from "./matchEvidence"
import { WeeklyEditionHistory } from "./WeeklyEditionHistory"
import { canRematchIncomplete } from "../../playlistSync/initialMatching"
import { isCompletedPartialMatch } from "../../playlistSync/linked"
import { useCopyOwner } from "./useCopyOwner"
import { useProviderStore } from "../../stores/providerStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
import { useLinkedPlaylistStore } from "../../stores/linkedPlaylistStore"
import {
  nativeListenBrainzPlaylists,
  listenBrainzPlaylistAdapter,
  type ListenBrainzPlaylistSummary,
} from "../../playlistSync/listenbrainz"
import {
  providerPlaylistAccount,
  providerPlaylistAdapter,
} from "../../playlistSync/provider"
import { linkedSyncServices } from "../../playlistSync/linkedServices"
import {
  linkedPlaylistRepository,
  type LinkedPlaylistRepository,
} from "../../playlistSync/linkedJournal"
import {
  checkLinkedPlaylist,
  reconcileLinkedStep,
  archiveReviewedLinkedStep,
  type LinkedSyncServices,
} from "../../playlistSync/linkedExecution"
import {
  linkedSyncDirection,
  linkedAutomaticSync,
  type LinkedSyncDirection,
  playlistContent,
  playlistContentHash,
  type LinkedPlaylist,
  type SyncSide,
  type LinkedTrackMapping,
} from "../../playlistSync/linked"
import {
  planPlaylistCopy,
  resolvePlaylistOccurrence,
  resolvedTracks,
} from "../../playlistSync/planner"
import { recordingMbid } from "../../playlistSync/matching"
import {
  samePlaylistIdentity,
  type PlaylistAccount,
  type PlaylistSnapshot,
  type PlaylistPlan,
  type PlaylistAdapter,
} from "../../playlistSync/types"
import {
  validWeeklyEdition,
  type WeeklySourceBinding,
} from "../../playlistSync/weekly"
import type { MusicProvider } from "../../providers/types"
import type { MusicPlaylist } from "../../types/music"
import {
  createLinkedSync,
  syncCreationJournal,
  type SyncCreationJournal,
} from "../../playlistSync/creation"
const NEW_REMOTE = "__new_listenbrainz_playlist__"
const button =
  "rounded-lg border border-[var(--border)] bg-app-surface px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
export interface LinkedPlaylistManagerServices {
  creationJournal?: SyncCreationJournal
  account(): Promise<PlaylistAccount>
  library(provider: MusicProvider, link?: LinkedPlaylist): PlaylistAdapter
  remote(account: PlaylistAccount): PlaylistAdapter & {
    list(
      offset?: number,
      count?: number
    ): Promise<{ items: PlaylistSnapshot[]; total: number }>
    listAll?(): Promise<{
      items: ListenBrainzPlaylistSummary[]
      total: number
      complete: boolean
      truncated: boolean
    }>
  }
  sync(
    provider: MusicProvider,
    link: LinkedPlaylist,
    current: () => boolean
  ): Promise<LinkedSyncServices>
  repository: LinkedPlaylistRepository
}
export const linkedPlaylistManagerServices: LinkedPlaylistManagerServices = {
  account: () => nativeListenBrainzPlaylists.account(),
  library: (provider, link) =>
    providerPlaylistAdapter(provider, {
      verifiedMbid: (track) => {
        const values = new Set(
          link?.mappings
            .filter((mapping) => mapping.libraryTrack.id === track.id)
            .map((mapping) => mapping.recordingMbid)
        )
        return values.size === 1 ? [...values][0] : null
      },
    }),
  remote: (account) => listenBrainzPlaylistAdapter(account),
  sync: linkedSyncServices,
  repository: linkedPlaylistRepository,
  creationJournal: syncCreationJournal,
}
interface Preview {
  library: PlaylistSnapshot
  remote: PlaylistSnapshot
  source: SyncSide
  plan: PlaylistPlan
  existing?: LinkedPlaylist
  owner: () => boolean
}
export function LinkedPlaylistManager({
  playlistId,
  selectedRemote,
  weeklySource,
  initialDirection = "export",
  embedded = false,
  onBusyChange,
  initialTab = "setup",
  onClose,
  services = linkedPlaylistManagerServices,
}: {
  playlistId?: string
  weeklySource?: WeeklySourceBinding
  selectedRemote?: ListenBrainzPlaylistSummary
  initialDirection?: LinkedSyncDirection
  embedded?: boolean
  onBusyChange?(busy: boolean): void
  initialTab?: "setup" | "review" | "settings"
  onClose(): void
  services?: LinkedPlaylistManagerServices
}) {
  const tabsId = useId()
  const provider = useProviderStore((s) => s.provider),
    authenticated = useListenBrainzStore((s) => s.isAuthenticated),
    username = useListenBrainzStore((s) => s.username)
  const capture = useCopyOwner(provider, `linked:${playlistId ?? ""}`)
  const backgroundRunning = useLinkedPlaylistStore((state) => state.running)
  const checkedErrors = useLinkedPlaylistStore((state) => state.checkedErrors)
  const [links, setLinks] = useState<LinkedPlaylist[]>([]),
    [libraries, setLibraries] = useState<MusicPlaylist[]>([]),
    [remotes, setRemotes] = useState<PlaylistSnapshot[]>([])
  const [libraryId, setLibraryId] = useState(playlistId ?? ""),
    [remoteId, setRemoteId] = useState(
      selectedRemote?.id ?? (initialDirection === "import" ? "" : NEW_REMOTE)
    ),
    [source, setSource] = useState<SyncSide>(
      initialDirection === "import" ? "listenbrainz" : "library"
    ),
    [direction, setDirection] = useState<LinkedSyncDirection>(initialDirection),
    [automatic, setAutomatic] = useState(false),
    [tab, setTab] = useState<"setup" | "review" | "settings">(initialTab),
    [page, setPage] = useState(0),
    [total, setTotal] = useState(0)
  const [otherLinks, setOtherLinks] = useState<LinkedPlaylist[]>([])
  const [rebindView, setRebindView] = useState<{
    link: LinkedPlaylist
    library: PlaylistSnapshot
    remote: PlaylistSnapshot
  } | null>(null)
  const [rebindApproved, setRebindApproved] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState(0)
  const [resolving, setResolving] = useState(false)
  const admission = useRef(false),
    request = useRef(0),
    lease = useRef<PlaylistAccount | null>(null)
  const createdRemoteIds = useRef(new Set<string>())
  const [newRemoteTitle, setNewRemoteTitle] = useState<string | null>(null)
  const newTitle =
    newRemoteTitle ??
    libraries.find((item) => item.id === libraryId)?.title ??
    ""
  const [recoveryViews, setRecoveryViews] = useState<
    Record<string, PlaylistSnapshot>
  >({})
  const [recoveryApproval, setRecoveryApproval] = useState<
    Record<string, boolean>
  >({})
  useEffect(() => {
    onBusyChange?.(busy)
    return () => onBusyChange?.(false)
  }, [busy, onBusyChange])
  const remoteWritable = (id: string) => {
    if (id === NEW_REMOTE || createdRemoteIds.current.has(id)) return true
    const summary =
      selectedRemote?.id === id
        ? selectedRemote
        : (remotes.find((item) => item.id === id) as
            ListenBrainzPlaylistSummary | undefined)
    return (
      summary?.access?.writable ?? services !== linkedPlaylistManagerServices
    )
  }
  const smartLibrary = (id: string) =>
    libraries.some((item) => item.id === id && item.smart)
  const save = async (link: LinkedPlaylist, revision: number | null) =>
    services === linkedPlaylistManagerServices
      ? useLinkedPlaylistStore.getState().save(link, revision)
      : services.repository.save(link, revision)
  const publish = (link: LinkedPlaylist) => {
    setLinks((previous) => [
      ...previous.filter((item) => item.id !== link.id),
      link,
    ])
    if (services === linkedPlaylistManagerServices)
      useLinkedPlaylistStore.getState().publish(link)
  }
  useEffect(() => {
    if (services !== linkedPlaylistManagerServices || !provider) return
    const owns = capture()
    return useLinkedPlaylistStore.subscribe((next, previous) => {
      if (next.links === previous.links || !owns() || !lease.current) return
      setLinks(
        next.links.filter(
          (link) =>
            (!playlistId || link.libraryPlaylistId === playlistId) &&
            samePlaylistIdentity(
              link.library,
              providerPlaylistAccount(provider)
            ) &&
            samePlaylistIdentity(link.listenbrainz, lease.current!)
        )
      )
    })
  }, [provider, playlistId, services, capture])
  useEffect(() => {
    const owns = capture(),
      revision = ++request.current
    setBusy(true)
    setError(null)
    setPreview(null)
    setRecoveryViews({})
    setRecoveryApproval({})
    setApproved(false)
    if (
      !provider ||
      provider.isOffline ||
      !provider.mutatePlaylistOccurrence ||
      !authenticated
    ) {
      setBusy(false)
      return
    }
    void (async () => {
      try {
        const account = await services.account()
        if (!owns() || revision !== request.current) return
        const [local, remote, stored] = await Promise.all([
          provider.getPlaylists(),
          selectedRemote
            ? Promise.resolve({ items: [selectedRemote], total: 1 })
            : services.remote(account).listAll
              ? services.remote(account).listAll!()
              : services.remote(account).list(page * 50, 50),
          services.repository.load(),
        ])
        if (!owns() || revision !== request.current) return
        lease.current = account
        setLibraries(local)
        setRemotes(selectedRemote ? [selectedRemote] : remote.items)
        setTotal(selectedRemote ? 1 : remote.total)
        const currentStored = stored.map((link) => {
          const live =
            services === linkedPlaylistManagerServices
              ? useLinkedPlaylistStore
                  .getState()
                  .links.find((item) => item.id === link.id)
              : undefined
          return live && live.revision >= link.revision ? live : link
        })
        setOtherLinks(
          currentStored.filter(
            (link) =>
              !samePlaylistIdentity(
                link.library,
                providerPlaylistAccount(provider)
              ) && samePlaylistIdentity(link.listenbrainz, account)
          )
        )
        setLinks(
          currentStored.filter(
            (link) =>
              (!playlistId || link.libraryPlaylistId === playlistId) &&
              samePlaylistIdentity(
                link.library,
                providerPlaylistAccount(provider)
              ) &&
              samePlaylistIdentity(link.listenbrainz, account)
          )
        )
        const existing = currentStored.find(
          (link) =>
            (!playlistId || link.libraryPlaylistId === playlistId) &&
            (!selectedRemote ||
              link.listenbrainzPlaylistId === selectedRemote.id) &&
            samePlaylistIdentity(
              link.library,
              providerPlaylistAccount(provider)
            ) &&
            samePlaylistIdentity(link.listenbrainz, account)
        )
        if (existing) {
          setDirection(linkedSyncDirection(existing))
          setAutomatic(linkedAutomaticSync(existing))
          setSource(
            linkedSyncDirection(existing) === "import"
              ? "listenbrainz"
              : "library"
          )
          setTab(initialTab === "review" ? "review" : "settings")
        }
      } catch {
        if (owns() && revision === request.current)
          setError(
            "Could not load linked playlists. Retry local settings and account connections."
          )
      } finally {
        if (owns() && revision === request.current) setBusy(false)
      }
    })()
    return () => {
      request.current++
    }
  }, [
    provider,
    provider?.cacheScope,
    provider?.playbackSession,
    authenticated,
    username,
    page,
    retry,
    services,
    capture,
    playlistId,
    selectedRemote,
  ])
  async function rebind(link: LinkedPlaylist, commit = false) {
    if (
      !provider ||
      admission.current ||
      link.job?.step ||
      link.job?.descriptionStep ||
      !services.repository.rebind
    )
      return
    admission.current = true
    const owns = capture()
    setBusy(true)
    setError(null)
    try {
      const account = await services.account(),
        [library, remote] = await Promise.all([
          services.library(provider).read(link.libraryPlaylistId),
          services.remote(account).read(link.listenbrainzPlaylistId),
        ])
      if (!owns() || !samePlaylistIdentity(account, link.listenbrainz))
        throw Error("Account changed")
      if (!commit) {
        setRebindView({ link, library, remote })
        setRebindApproved(false)
        return
      }
      if (
        !rebindApproved ||
        !rebindView ||
        rebindView.link.id !== link.id ||
        playlistContent(library) !== playlistContent(rebindView.library) ||
        playlistContent(remote) !== playlistContent(rebindView.remote)
      )
        throw Error("Rebind preview changed")
      const retained = await services.repository.rebind(
        link,
        link.revision,
        library.account
      )
      if (owns()) {
        publish(retained)
        setOtherLinks((previous) =>
          previous.filter((item) => item.id !== link.id)
        )
        setRebindView(null)
        setRebindApproved(false)
      }
    } catch {
      if (owns())
        setError(
          "Connection rebind was not confirmed. Reconnect the original account or reload this preview; no server update was sent."
        )
    } finally {
      admission.current = false
      if (owns()) setBusy(false)
    }
  }
  async function prepare(existing?: LinkedPlaylist) {
    if (
      smartLibrary(existing?.libraryPlaylistId ?? libraryId) &&
      (existing ? linkedSyncDirection(existing) : direction) !== "export"
    ) {
      setError(
        "Smart playlists support Plex → ListenBrainz only. Choose export sync for this playlist."
      )
      return
    }
    if (
      !remoteWritable(existing?.listenbrainzPlaylistId ?? remoteId ?? "") &&
      direction !== "import"
    ) {
      setError(
        "This read-only ListenBrainz source supports import to Plex only."
      )
      return
    }
    if (
      !provider ||
      !lease.current ||
      admission.current ||
      (!libraryId && !existing) ||
      (!remoteId && !existing)
    )
      return
    admission.current = true
    const owns = capture(),
      revision = ++request.current
    setBusy(true)
    setError(null)
    setApproved(false)
    try {
      if (existing) {
        setDirection(linkedSyncDirection(existing))
        setAutomatic(linkedAutomaticSync(existing))
      }
      const reviewSource = existing
        ? linkedSyncDirection(existing) === "import"
          ? "listenbrainz"
          : linkedSyncDirection(existing) === "export"
            ? "library"
            : source
        : source
      setSource(reviewSource)
      const currentLease = await services.account()
      if (!owns() || !samePlaylistIdentity(currentLease, lease.current))
        throw Error("Account changed")
      const [library, remote] = await Promise.all([
        services
          .library(provider, existing)
          .read(existing?.libraryPlaylistId ?? libraryId),
        services
          .remote(currentLease)
          .read(existing?.listenbrainzPlaylistId ?? remoteId),
      ])
      if (!owns() || revision !== request.current) return
      if (
        library.readOnly &&
        (existing ? linkedSyncDirection(existing) : direction) !== "export"
      ) {
        setError(
          "This playlist is now smart and supports export sync only. Review its direction before continuing."
        )
        return
      }
      const copyDirection = reviewSource === "library" ? "export" : "import",
        sourceSnapshot = reviewSource === "library" ? library : remote,
        target = reviewSource === "library" ? remote.account : library.account
      const plan = planPlaylistCopy(sourceSnapshot, target, {
        direction: copyDirection,
        candidates: library.items.map((item) => item.track),
      })
      setPreview({
        library,
        remote,
        source: reviewSource,
        plan,
        existing,
        owner: owns,
      })
      setTab("review")
    } catch {
      if (owns())
        setError(
          "Could not preview both ordered playlists. Check the original accounts and the 1,000-song limit."
        )
    } finally {
      admission.current = false
      if (owns()) setBusy(false)
    }
  }
  async function createRemote() {
    if (
      !provider ||
      !libraryId ||
      !newTitle.trim() ||
      admission.current ||
      direction !== "export"
    )
      return
    admission.current = true
    const owns = capture()
    setBusy(true)
    setError(null)
    let created: LinkedPlaylist | undefined
    try {
      const account = await services.account()
      if (
        !owns() ||
        !lease.current ||
        !samePlaylistIdentity(account, lease.current)
      )
        throw Error("Creation account changed")
      const result =
        services === linkedPlaylistManagerServices
          ? await useLinkedPlaylistStore
              .getState()
              .createSync(
                {
                  account: providerPlaylistAccount(provider),
                  id: libraryId,
                  title: newTitle,
                  items: [],
                },
                newTitle,
                owns,
                undefined,
                "export"
              )
          : await createLinkedSync(libraryId, newTitle, {
              direction: "export",
              source: services.library(provider),
              target: services.remote(account),
              journal: services.creationJournal ?? syncCreationJournal,
              links: services.repository,
              current: owns,
              admissionCurrent: owns,
            })
      if (!owns()) return
      created = result.link
      createdRemoteIds.current.add(created.listenbrainzPlaylistId)
      setRemotes((previous) => [
        created!.baseline.listenbrainz,
        ...previous.filter(
          (item) => item.id !== created!.listenbrainzPlaylistId
        ),
      ])
      setRemoteId(created.listenbrainzPlaylistId)
      publish(created)
    } catch {
      if (owns())
        setError(
          "Creation was not confirmed. Check Playlists → Sync for its recovery receipt before requesting another playlist."
        )
    } finally {
      admission.current = false
      if (owns()) setBusy(false)
    }
    if (created && owns()) await prepare(created)
  }
  async function enable() {
    if (
      !remoteWritable(remoteId || preview?.remote.id || "") &&
      direction !== "import"
    ) {
      setError(
        "This read-only ListenBrainz source supports import to Plex only."
      )
      return
    }
    if (!provider || !preview || !approved || resolving || admission.current)
      return
    if (!preview.owner()) {
      setError("The playlist connection changed. Reload Setup before saving.")
      return
    }
    const rows = preview.plan.rows
    if (
      rows.some(
        (row) => row.match.status !== "matched" || row.match.by === "metadata"
      )
    ) {
      setError(
        "Confirm every suggested local match and resolve every recording before enabling sync."
      )
      return
    }
    admission.current = true
    const owns = capture()
    setBusy(true)
    setError(null)
    try {
      const tracks = resolvedTracks(preview.plan),
        existing = preview.existing,
        currentLease = await services.account()
      const [library, remote] = await Promise.all([
        services.library(provider, existing).read(preview.library.id),
        services.remote(currentLease).read(preview.remote.id),
      ])
      if (
        !owns() ||
        !samePlaylistIdentity(currentLease, preview.remote.account) ||
        !samePlaylistIdentity(library.account, preview.library.account) ||
        library.id !== preview.library.id ||
        remote.id !== preview.remote.id ||
        playlistContent(library) !== playlistContent(preview.library) ||
        playlistContent(remote) !== playlistContent(preview.remote) ||
        snapshotRevision(preview.source === "library" ? library : remote) !==
          snapshotRevision(
            preview.source === "library" ? preview.library : preview.remote
          )
      )
        throw Error("Preview changed")
      if (existing?.job?.step || existing?.job?.descriptionStep)
        throw Error("Reconcile the retained operation first")
      if (library.readOnly && direction !== "export")
        throw Error("Smart playlists cannot be changed by sync")
      const mappings: LinkedTrackMapping[] = rows.map((row, index) => ({
        libraryTrack: preview.source === "library" ? row.source : tracks[index],
        recordingMbid: recordingMbid(
          preview.source === "library"
            ? tracks[index].recordingMbid
            : row.source.recordingMbid
        )!,
        verifiedBy: "reviewed",
        ...(preview.source === "listenbrainz"
          ? { sourceOccurrenceId: row.occurrenceId }
          : {}),
      }))
      if (mappings.some((mapping) => !mapping.recordingMbid))
        throw Error("Missing verified recording")
      const desired =
        preview.source === "library"
          ? tracks.map((track) => ({
              ...track,
              id: recordingMbid(track.recordingMbid)!,
            }))
          : tracks
      const destination = preview.source === "library" ? remote : library,
        sourceSnapshot = preview.source === "library" ? library : remote
      if (
        preview.source === "listenbrainz" &&
        new Set(desired.map((track) => track.id)).size !== desired.length
      ) {
        setError(
          "Plex cannot retain repeated copies of the same track ID. Choose a distinct local version for each repeated occurrence; no update was admitted."
        )
        return
      }
      const matching =
        JSON.stringify(destination.items.map((item) => item.track.id)) ===
        JSON.stringify(desired.map((track) => track.id))
      const next: LinkedPlaylist = {
        ...(existing ?? {}),
        version: 1,
        revision: existing?.revision ?? 0,
        id: existing?.id ?? crypto.randomUUID(),
        library: library.account,
        listenbrainz: remote.account,
        libraryPlaylistId: library.id,
        listenbrainzPlaylistId: remote.id,
        direction,
        automatic,
        weeklySource:
          weeklySource &&
          validWeeklyEdition(weeklySource.edition, remote.account)
            ? {
                ...weeklySource,
                lastSyncedEditionId: matching
                  ? weeklySource.edition.playlistId
                  : undefined,
              }
            : existing?.weeklySource,
        enabled: true,
        paused: false,
        pauseReason: undefined,
        state: "ready",
        message: undefined,
        baseline: { library, listenbrainz: remote },
        baselineHashes: {
          library: await playlistContentHash(library),
          listenbrainz: await playlistContentHash(remote),
        },
        mappings: [
          ...(existing?.mappings ?? []).filter(
            (mapping) =>
              !mappings.some(
                (next) =>
                  next.sourceOccurrenceId &&
                  next.sourceOccurrenceId === mapping.sourceOccurrenceId
              )
          ),
          ...mappings,
        ].filter(
          (mapping, index, all) =>
            all.findIndex(
              (other) =>
                other.libraryTrack.id === mapping.libraryTrack.id &&
                other.recordingMbid === mapping.recordingMbid &&
                other.sourceOccurrenceId === mapping.sourceOccurrenceId
            ) === index
        ),
        incomplete: undefined,
        job: matching
          ? undefined
          : {
              id: crypto.randomUUID(),
              source: preview.source,
              sourceSnapshot,
              destinationSnapshot: destination,
              desired,
              completedSteps: 0,
            },
      }
      if (!owns()) throw Error("Account changed")
      const retained = await save(next, existing?.revision ?? null)
      if (!owns()) return
      publish(retained)
      setPreview(null)
      setApproved(false)
      setTab("settings")
    } catch {
      if (owns())
        setError(
          "This preview could not be retained or changed. No new update was admitted. Reload and review again."
        )
    } finally {
      admission.current = false
      if (owns()) setBusy(false)
    }
  }
  async function preferences(
    link: LinkedPlaylist,
    nextDirection: LinkedSyncDirection,
    nextAutomatic: boolean
  ) {
    if (smartLibrary(link.libraryPlaylistId) && nextDirection !== "export") {
      setError("Smart playlists support export sync only.")
      return
    }
    if (
      admission.current ||
      (!remoteWritable(link.listenbrainzPlaylistId) &&
        nextDirection !== "import")
    )
      return
    admission.current = true
    const owns = capture()
    setBusy(true)
    setError(null)
    useLinkedPlaylistStore.getState().hold(link.id, true)
    try {
      const retained = await save(
        { ...link, direction: nextDirection, automatic: nextAutomatic },
        link.revision
      )
      if (owns()) {
        publish(retained)
        useLinkedPlaylistStore.getState().hold(link.id, false)
      }
    } catch {
      if (owns())
        setError(
          "Sync settings were not retained. Updates remain paused; reload recovery settings before retrying."
        )
    } finally {
      admission.current = false
      if (owns()) setBusy(false)
    }
  }
  async function settings(
    link: LinkedPlaylist,
    paused: boolean,
    enabled = link.enabled
  ) {
    if (admission.current) return
    admission.current = true
    const owns = capture()
    setBusy(true)
    setError(null)
    useLinkedPlaylistStore.getState().hold(link.id, true)
    try {
      const retained = await save(
        {
          ...link,
          paused,
          enabled,
          pauseReason: paused ? "manual" : undefined,
        },
        link.revision
      )
      if (owns()) publish(retained)
      useLinkedPlaylistStore.getState().hold(link.id, false)
    } catch {
      if (owns())
        setError(
          "The setting was not retained. Updates are paused for this session; retry saving before restarting."
        )
    } finally {
      admission.current = false
      if (owns()) setBusy(false)
    }
  }
  async function check(link: LinkedPlaylist, reconcile = false) {
    if (!provider || admission.current) return
    admission.current = true
    const owns = capture()
    setBusy(true)
    setError(null)
    try {
      if (!reconcile && services === linkedPlaylistManagerServices) {
        const checked = await useLinkedPlaylistStore
          .getState()
          .syncNow(link.id, owns)
        if (owns()) publish(checked)
        return
      }
      const sync = await services.sync(provider, link, owns)
      sync.repository = {
        load: services.repository.load,
        save: (next, version) => save(next, version),
      }
      let checked: LinkedPlaylist
      if (reconcile) {
        if (recoveryViews[link.id] && recoveryApproval[link.id])
          checked = await archiveReviewedLinkedStep(
            link,
            sync,
            recoveryViews[link.id]
          )
        else {
          const job = link.job!,
            destination = job.descriptionStep
              ? "library"
              : job.source === "library"
                ? "listenbrainz"
                : "library",
            actual = await sync[destination].read(
              (job.descriptionStep ?? job.step)!.before.id
            )
          if (!owns()) return
          setRecoveryViews((previous) => ({ ...previous, [link.id]: actual }))
          setRecoveryApproval((previous) => ({ ...previous, [link.id]: false }))
          if (
            job.descriptionStep
              ? actual.description !== job.descriptionStep.description
              : JSON.stringify(actual.items.map((item) => item.track.id)) !==
                  JSON.stringify(job.step!.afterIds) ||
                actual.title !== job.step!.before.title
          )
            return
          checked = await reconcileLinkedStep(link, sync)
        }
      } else checked = await checkLinkedPlaylist(link, sync, 20)
      if (owns()) publish(checked)
    } catch {
      if (owns())
        setError(
          reconcile
            ? "Read-only reconciliation could not confirm this outcome. Review the destination before retrying; no request was resent."
            : "Could not finish this check. Any admitted update remains retained for reconciliation."
        )
    } finally {
      admission.current = false
      if (owns()) setBusy(false)
    }
  }
  async function retryBackgroundMatching(link: LinkedPlaylist) {
    if (admission.current || backgroundRunning[link.id]) return
    admission.current = true
    const owns = capture()
    setBusy(true)
    setError(null)
    try {
      await useLinkedPlaylistStore.getState().retryMatching(link.id, owns)
    } catch {
      if (owns())
        setError(
          "Matching could not resume. Check the original connection and retained update before retrying. No new playlist was created."
        )
    } finally {
      admission.current = false
      if (owns()) setBusy(false)
    }
  }
  const unsupported =
    !provider ||
    provider.isOffline ||
    !provider.mutatePlaylistOccurrence ||
    !authenticated
  return (
    <PlaylistSyncFrame
      embedded={embedded}
      title="Configure playlist sync"
      description="Choose the direction, review every song and keep automatic updates off until you opt in."
      onClose={onClose}
      canClose={!busy}
    >
      <div
        role="tablist"
        onKeyDown={navigateSyncTabs}
        aria-label="Playlist sync configuration"
        className="mb-5 flex flex-wrap gap-1 rounded-xl bg-app-surface p-1"
      >
        {(["setup", "review", "settings"] as const).map((value) => (
          <button
            key={value}
            role="tab"
            id={`${tabsId}-${value}`}
            aria-controls={`${tabsId}-panel`}
            tabIndex={tab === value ? 0 : -1}
            aria-selected={tab === value}
            className={`${button} ${tab === value ? "bg-app-surface-hover font-semibold" : "border-transparent"}`}
            disabled={busy || resolving}
            onClick={() => setTab(value)}
          >
            {value === "setup"
              ? "Setup"
              : value === "review"
                ? "Review"
                : "Settings"}
          </button>
        ))}
      </div>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        Choose which playlist updates the other. Sync runs manually unless you
        enable automatic checks while Hibiki is open and online. Conflicting
        edits pause for your review.
      </p>
      <div
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-${tab}`}
      >
        {unsupported ? (
          <p role="status">
            Connect ListenBrainz and an online library with playlist editing
            support.
          </p>
        ) : (
          <>
            {error && (
              <div
                role="alert"
                className="mb-4 text-sm text-[var(--text-primary)]"
              >
                {error}
                <button
                  className={`${button} ml-2`}
                  disabled={busy || resolving}
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Reload settings
                </button>
              </div>
            )}
            {busy && <p role="status">Reading or retaining playlist state…</p>}
            {!preview && tab === "setup" && (
              <section
                aria-label="Set up a linked playlist"
                className="mb-6 space-y-3"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm">
                    Library playlist
                    <select
                      className={`${button} mt-1 w-full`}
                      value={libraryId}
                      disabled={busy || resolving}
                      onChange={(event) => {
                        setLibraryId(event.target.value)
                        setNewRemoteTitle(null)
                        if (smartLibrary(event.target.value)) {
                          setDirection("export")
                          setSource("library")
                        }
                      }}
                    >
                      <option value="">Choose a playlist</option>
                      {libraries.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                          {item.smart ? " · Smart snapshot" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    ListenBrainz playlist
                    <select
                      className={`${button} mt-1 w-full`}
                      value={remoteId}
                      disabled={busy || resolving}
                      onChange={(event) => {
                        setRemoteId(event.target.value)
                        if (event.target.value === NEW_REMOTE) {
                          setDirection("export")
                          setSource("library")
                          setAutomatic(false)
                        }
                      }}
                    >
                      <option value="">Choose your playlist</option>
                      <option value={NEW_REMOTE}>
                        Create new ListenBrainz playlist
                      </option>
                      {remotes.map((item) => (
                        <option
                          key={item.id}
                          value={item.id}
                          disabled={
                            smartLibrary(libraryId) && !remoteWritable(item.id)
                          }
                        >
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {remoteId === NEW_REMOTE && (
                  <label className="block text-sm">
                    New ListenBrainz playlist name
                    <input
                      className={`${button} mt-1 w-full`}
                      value={newTitle}
                      maxLength={500}
                      disabled={busy || resolving}
                      onChange={(event) =>
                        setNewRemoteTitle(event.target.value)
                      }
                    />
                  </label>
                )}
                {total > 50 && (
                  <div className="flex gap-2">
                    <button
                      className={button}
                      disabled={busy || resolving || page === 0}
                      onClick={() => setPage((value) => value - 1)}
                    >
                      Previous playlists
                    </button>
                    <button
                      className={button}
                      disabled={busy || resolving || (page + 1) * 50 >= total}
                      onClick={() => setPage((value) => value + 1)}
                    >
                      Next playlists
                    </button>
                  </div>
                )}
                <label className="block text-sm">
                  Sync direction
                  <select
                    className={`${button} mt-1 w-full`}
                    value={direction}
                    disabled={busy || resolving}
                    onChange={(event) => {
                      const value = event.target.value as LinkedSyncDirection
                      setDirection(value)
                      if (value !== "bidirectional")
                        setSource(
                          value === "import" ? "listenbrainz" : "library"
                        )
                    }}
                  >
                    <option value="export" disabled={!remoteWritable(remoteId)}>
                      Plex → ListenBrainz
                    </option>
                    <option
                      value="import"
                      disabled={
                        smartLibrary(libraryId) || remoteId === NEW_REMOTE
                      }
                    >
                      ListenBrainz → Plex
                    </option>
                    <option
                      value="bidirectional"
                      disabled={
                        !remoteWritable(remoteId) ||
                        smartLibrary(libraryId) ||
                        remoteId === NEW_REMOTE
                      }
                    >
                      Two-way
                    </option>
                  </select>
                </label>
                {smartLibrary(libraryId) && (
                  <p className="text-sm text-[var(--text-secondary)]">
                    Smart playlists are read-only snapshots. Plex → ListenBrainz
                    copies their current songs; sync never changes the smart
                    playlist or its rules.
                  </p>
                )}
                {remoteId && !remoteWritable(remoteId) && (
                  <p className="text-sm text-[var(--text-secondary)]">
                    This ListenBrainz playlist is read-only. Sync can read it
                    and update Plex, but will never change the remote playlist.
                  </p>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={direction === "bidirectional"}
                    disabled={
                      busy ||
                      resolving ||
                      !remoteWritable(remoteId) ||
                      remoteId === NEW_REMOTE ||
                      smartLibrary(libraryId)
                    }
                    onChange={(event) =>
                      setDirection(
                        event.target.checked
                          ? "bidirectional"
                          : source === "listenbrainz"
                            ? "import"
                            : "export"
                      )
                    }
                  />
                  Enable two-way sync
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={automatic}
                    disabled={busy || resolving || remoteId === NEW_REMOTE}
                    onChange={(event) => setAutomatic(event.target.checked)}
                  />
                  {weeklySource
                    ? "Follow new weekly editions automatically while Hibiki is open"
                    : "Automatically check this link while Hibiki is open"}
                </label>
                <p className="text-xs text-[var(--text-secondary)]">
                  {weeklySource
                    ? "Weekly following is opt-in. New editions update while Hibiki is open, or on the next launch; Hibiki cannot run scheduled updates while closed."
                    : "Automatic updates are off by default."}{" "}
                  {remoteId === NEW_REMOTE
                    ? "Create a private ListenBrainz playlist, then review its recordings before syncing."
                    : "Saving a link retains the reviewed plan; use Sync to run it."}
                </p>
                <label className="block text-sm">
                  Initial version to keep
                  <select
                    className={`${button} ml-2`}
                    value={source}
                    disabled={
                      busy || resolving || direction !== "bidirectional"
                    }
                    onChange={(event) =>
                      setSource(event.target.value as SyncSide)
                    }
                  >
                    <option value="library">Library order</option>
                    <option value="listenbrainz">ListenBrainz order</option>
                  </select>
                </label>
                <button
                  className={button}
                  disabled={
                    busy ||
                    resolving ||
                    !libraryId ||
                    !remoteId ||
                    (remoteId === NEW_REMOTE &&
                      (!newTitle.trim() ||
                        links.some(
                          (link) => link.libraryPlaylistId === libraryId
                        )))
                  }
                  onClick={() =>
                    void (remoteId === NEW_REMOTE ? createRemote() : prepare())
                  }
                >
                  {remoteId === NEW_REMOTE
                    ? "Create ListenBrainz playlist"
                    : "Preview link"}
                </button>
              </section>
            )}
            {!preview && tab === "review" && (
              <p
                role="status"
                className="rounded-xl border border-[var(--border)] p-4"
              >
                Choose a source and destination in Setup, or review a retained
                link below.
              </p>
            )}
            {preview && tab === "review" && (
              <section
                aria-label="Review linked playlist occurrences"
                className="space-y-4"
              >
                <h3 className="font-semibold">
                  Review {preview.plan.rows.length} ordered occurrences
                </h3>
                <p className="text-sm text-[var(--text-secondary)]">
                  The initial{" "}
                  {preview.source === "library" ? "library" : "ListenBrainz"}{" "}
                  version will update the other playlist. Confirm every
                  recording; unknown matches are never guessed.
                </p>
                <details className="rounded-lg border border-[var(--border)] p-3">
                  <summary className="cursor-pointer text-sm">
                    Current destination:{" "}
                    {
                      (preview.source === "library"
                        ? preview.remote
                        : preview.library
                      ).title
                    }{" "}
                    ·{" "}
                    {
                      (preview.source === "library"
                        ? preview.remote
                        : preview.library
                      ).items.length
                    }{" "}
                    occurrences
                  </summary>
                  <ol className="mt-2 max-h-40 overflow-auto text-sm">
                    {(preview.source === "library"
                      ? preview.remote
                      : preview.library
                    ).items.map((item, index) => (
                      <li key={item.occurrenceId}>
                        {index + 1}. {item.track.artist} —{" "}
                        {item.track.title || "Untitled recording"}
                      </li>
                    ))}
                  </ol>
                </details>
                <VerifiedRecordingsAction
                  provider={provider}
                  plan={preview.plan}
                  current={capture}
                  disabled={busy || resolving}
                  onRunning={setResolving}
                  onResolved={(plan) =>
                    setPreview((previous) =>
                      previous?.plan === preview.plan && previous.owner()
                        ? { ...previous, plan }
                        : previous
                    )
                  }
                />
                <ol className="max-h-[45vh] space-y-3 overflow-auto">
                  {preview.plan.rows.map((row, index) => (
                    <li key={row.occurrenceId}>
                      <OccurrenceResolver
                        index={index}
                        row={row}
                        evidenceLabel={linkedMatchEvidenceLabel(
                          row,
                          preview.source,
                          preview.existing?.mappings ?? []
                        )}
                        mode={
                          preview.source === "library" ? "export" : "import"
                        }
                        disabled={busy || resolving}
                        provider={provider}
                        current={capture}
                        onResolve={(track) =>
                          preview.owner() &&
                          setPreview((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  plan: resolvePlaylistOccurrence(
                                    previous.plan,
                                    row.occurrenceId,
                                    track
                                  ),
                                }
                              : previous
                          )
                        }
                      />
                      {row.match.status === "matched" &&
                        row.match.by === "metadata" && (
                          <button
                            className={`${button} mt-2`}
                            disabled={busy || resolving}
                            onClick={() => {
                              if (
                                row.match.status !== "matched" ||
                                !capture()()
                              )
                                return
                              const selected = row.match.track
                              setPreview((previous) =>
                                previous
                                  ? {
                                      ...previous,
                                      plan: resolvePlaylistOccurrence(
                                        previous.plan,
                                        row.occurrenceId,
                                        selected
                                      ),
                                    }
                                  : previous
                              )
                            }}
                          >
                            Confirm local match occurrence {index + 1}
                          </button>
                        )}
                    </li>
                  ))}
                </ol>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={approved}
                    disabled={busy || resolving}
                    onChange={(event) => setApproved(event.target.checked)}
                  />
                  I reviewed every ordered song and approve this link and its
                  selected sync direction. No unresolved songs will be dropped.
                </label>
                <div className="flex gap-2">
                  <button
                    className={button}
                    disabled={busy || resolving || !approved}
                    onClick={() => void enable()}
                  >
                    Save reviewed link
                  </button>
                  <button
                    className={button}
                    disabled={busy || resolving}
                    onClick={() => {
                      setPreview(null)
                      setApproved(false)
                    }}
                  >
                    Back
                  </button>
                </div>
              </section>
            )}
            {otherLinks.length > 0 && (
              <section
                aria-label="Previous connection links"
                className="mt-6 rounded-lg border border-[var(--border)] p-3"
              >
                <p className="text-sm">
                  {otherLinks.length} links belong to a different library
                  connection and are paused here. Plex credential or server
                  changes require explicit review; accounts are never rebound
                  automatically.
                </p>
                {otherLinks.map((link) => {
                  const available = libraries.find(
                    (item) => item.id === link.libraryPlaylistId
                  )
                  return (
                    <div className="mt-2" key={link.id}>
                      {available &&
                      !(link.job?.step || link.job?.descriptionStep) &&
                      services.repository.rebind ? (
                        <button
                          className={button}
                          disabled={busy || resolving}
                          onClick={() => void rebind(link)}
                        >
                          Review connection for {available.title}
                        </button>
                      ) : (
                        <p className="text-xs text-[var(--text-secondary)]">
                          Reconnect the original connection to review its
                          unavailable playlist or unresolved update.
                        </p>
                      )}
                    </div>
                  )
                })}
              </section>
            )}
            {rebindView && (
              <section
                aria-label="Review connection identity"
                className="mt-4 space-y-3 rounded-lg border border-[var(--border)] p-3"
              >
                <h3 className="font-semibold">
                  Current library playlist: {rebindView.library.title}
                </h3>
                <p className="text-sm">
                  {rebindView.library.items.length} library occurrences ↔{" "}
                  {rebindView.remote.items.length} ListenBrainz occurrences for{" "}
                  {rebindView.remote.account.user}. This records a new
                  connection identity only; it does not update either service.
                  Any incomplete confirmed plan is stopped and must be previewed
                  again.
                </p>
                <ol className="max-h-40 overflow-auto text-sm">
                  {rebindView.library.items.map((item, index) => (
                    <li key={item.occurrenceId}>
                      {index + 1}. {item.track.artist} — {item.track.title}
                    </li>
                  ))}
                </ol>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={rebindApproved}
                    disabled={busy || resolving}
                    onChange={(event) =>
                      setRebindApproved(event.target.checked)
                    }
                  />
                  I confirm this is my original Plex account, server and music
                  library and reviewed the current playlist.
                </label>
                <button
                  className={button}
                  disabled={busy || resolving || !rebindApproved}
                  onClick={() => void rebind(rebindView.link, true)}
                >
                  Retain reviewed connection
                </button>
              </section>
            )}
            <section
              hidden={tab !== "settings" && tab !== "review"}
              aria-label="Existing linked playlists"
              className="mt-6 space-y-4"
            >
              {links.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">
                  No linked playlists for these accounts.
                </p>
              ) : (
                links.map((link) => (
                  <article
                    key={link.id}
                    className="rounded-lg border border-[var(--border)] p-3"
                  >
                    <h3 className="font-semibold">
                      {link.baseline.library.title}{" "}
                      {linkedSyncDirection(link) === "export"
                        ? "→"
                        : linkedSyncDirection(link) === "import"
                          ? "←"
                          : "↔"}{" "}
                      {link.baseline.listenbrainz.title}
                    </h3>
                    <p className="mt-1 text-sm">
                      {link.listenbrainz.user} ·{" "}
                      {!link.enabled
                        ? "Disabled"
                        : isCompletedPartialMatch(link)
                          ? "Matches saved · review available"
                          : link.paused
                            ? "Paused"
                            : link.job
                              ? `Syncing · ${link.job.completedSteps} verified steps`
                              : "Enabled"}
                    </p>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">
                      {linkedAutomaticSync(link)
                        ? "Automatic checks on"
                        : "Manual sync · automatic checks off"}
                    </p>
                    {(smartLibrary(link.libraryPlaylistId) ||
                      link.baseline.library.readOnly) && (
                      <p className="mt-2 text-sm text-[var(--text-secondary)]">
                        Smart snapshot · Plex → ListenBrainz only. Sync never
                        changes this playlist’s songs or rules in Plex.
                      </p>
                    )}
                    {link.incomplete && (
                      <p className="mt-2 text-sm" role="status">
                        {(!isCompletedPartialMatch(link) && link.paused) ||
                        !link.enabled ||
                        link.state === "error" ||
                        (!isCompletedPartialMatch(link) &&
                          link.state === "conflict") ||
                        link.state === "unknown" ||
                        checkedErrors[link.id]
                          ? "Background matching is paused. Retry lookups or review the retained update."
                          : link.incomplete.matchingDone
                            ? `${link.incomplete.missingOccurrenceIds.length} ${link.incomplete.missingOccurrenceIds.length === 1 ? "song needs" : "songs need"} your review.`
                            : `Matching in the background · ${link.incomplete.matchedCount} of ${link.incomplete.total} songs matched.`}{" "}
                        {link.incomplete.matchedCount} matched. Songs that need
                        a choice stay in this review; they are not silently
                        discarded.
                      </p>
                    )}
                    {link.message && (
                      <p className="mt-1 text-sm" role="status">
                        {link.message}
                      </p>
                    )}
                    {!!link.incomplete?.lookupLimits?.length && (
                      <p className="mt-2 text-sm text-[var(--text-secondary)]">
                        Some catalogue lookups were incomplete or unavailable.
                        Those songs remain for review; this does not mean they
                        are missing from your library. Retry lookups or search
                        manually to choose a recording.
                      </p>
                    )}
                    {tab === "review" &&
                      link.weeklySource?.previousEditions && (
                        <WeeklyEditionHistory
                          receipts={link.weeklySource.previousEditions}
                        />
                      )}
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <label className="text-sm">
                        Direction for {link.baseline.library.title}
                        <select
                          className={`${button} mt-1 w-full`}
                          value={linkedSyncDirection(link)}
                          disabled={
                            busy ||
                            resolving ||
                            !!(link.job?.step || link.job?.descriptionStep) ||
                            !!link.incomplete
                          }
                          onChange={(event) =>
                            void preferences(
                              link,
                              event.target.value as LinkedSyncDirection,
                              linkedAutomaticSync(link)
                            )
                          }
                        >
                          <option
                            value="export"
                            disabled={
                              !remoteWritable(link.listenbrainzPlaylistId)
                            }
                          >
                            Plex → ListenBrainz
                          </option>
                          <option
                            value="import"
                            disabled={smartLibrary(link.libraryPlaylistId)}
                          >
                            ListenBrainz → Plex
                          </option>
                          <option
                            value="bidirectional"
                            disabled={
                              !remoteWritable(link.listenbrainzPlaylistId) ||
                              smartLibrary(link.libraryPlaylistId)
                            }
                          >
                            Two-way
                          </option>
                        </select>
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={linkedAutomaticSync(link)}
                          disabled={busy || resolving}
                          onChange={(event) =>
                            void preferences(
                              link,
                              linkedSyncDirection(link),
                              event.target.checked
                            )
                          }
                        />
                        {link.weeklySource
                          ? "Follow new weekly editions while Hibiki is open"
                          : "Automatic checks while Hibiki is open"}
                      </label>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {link.enabled &&
                        link.incomplete &&
                        link.pauseReason !== "manual" &&
                        (canRematchIncomplete(link) ||
                          (!link.incomplete.matchingDone &&
                            (link.state === "ready" ||
                              link.state === "error"))) &&
                        !(link.job?.step || link.job?.descriptionStep) && (
                          <button
                            className={button}
                            disabled={
                              busy || resolving || !!backgroundRunning[link.id]
                            }
                            onClick={() => void retryBackgroundMatching(link)}
                          >
                            {backgroundRunning[link.id]
                              ? "Matching songs…"
                              : canRematchIncomplete(link)
                                ? "Find more matches"
                                : "Retry background lookups"}
                          </button>
                        )}
                      <button
                        className={button}
                        disabled={busy || resolving}
                        onClick={() => void settings(link, true, false)}
                      >
                        Disable
                      </button>
                      {link.enabled && !link.paused && (
                        <button
                          className={button}
                          disabled={busy || resolving}
                          onClick={() => void settings(link, true)}
                        >
                          Pause
                        </button>
                      )}
                      {link.enabled && !link.paused && (
                        <button
                          className={button}
                          disabled={
                            busy || resolving || !!backgroundRunning[link.id]
                          }
                          onClick={() => void check(link)}
                        >
                          Sync now
                        </button>
                      )}
                      {link.job?.step || link.job?.descriptionStep ? (
                        <>
                          {recoveryViews[link.id] && (
                            <div className="basis-full rounded-lg border border-[var(--border)] p-3">
                              <p className="text-sm font-medium">
                                Current destination order ·{" "}
                                {recoveryViews[link.id].items.length}{" "}
                                occurrences
                              </p>
                              <ol className="mt-2 max-h-40 overflow-auto text-sm">
                                {recoveryViews[link.id].items.map(
                                  (item, index) => (
                                    <li key={item.occurrenceId}>
                                      {index + 1}. {item.track.artist} —{" "}
                                      {item.track.title || "Untitled recording"}
                                    </li>
                                  )
                                )}
                              </ol>
                              {link.job?.descriptionStep && (
                                <dl className="mt-3 space-y-1 text-sm">
                                  <dt className="font-medium">
                                    Retained weekly description
                                  </dt>
                                  <dd className="whitespace-pre-wrap">
                                    {link.job.descriptionStep.description}
                                  </dd>
                                  <dt className="font-medium">
                                    Current destination description
                                  </dt>
                                  <dd className="whitespace-pre-wrap">
                                    {recoveryViews[link.id].description ||
                                      "No description"}
                                  </dd>
                                </dl>
                              )}
                              <p className="mt-2 text-xs text-[var(--text-secondary)]">
                                The earlier request may have applied. Retaining
                                this review records the uncertain intent and
                                pauses updates; a new ordered preview is
                                required before another write.
                              </p>
                            </div>
                          )}
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              disabled={
                                busy || resolving || !recoveryViews[link.id]
                              }
                              checked={!!recoveryApproval[link.id]}
                              onChange={(event) =>
                                setRecoveryApproval((previous) => ({
                                  ...previous,
                                  [link.id]: event.target.checked,
                                }))
                              }
                            />
                            I reviewed the current destination and acknowledge
                            that the previous update may have applied.
                          </label>
                          <button
                            className={button}
                            disabled={busy || resolving}
                            onClick={() => void check(link, true)}
                          >
                            {recoveryViews[link.id] && recoveryApproval[link.id]
                              ? "Retain reviewed current state"
                              : "Read recovery proof"}
                          </button>
                        </>
                      ) : (
                        <button
                          className={button}
                          disabled={
                            busy || resolving || !!backgroundRunning[link.id]
                          }
                          onClick={() => void prepare(link)}
                        >
                          Review versions and resume
                        </button>
                      )}
                    </div>
                  </article>
                ))
              )}
            </section>
            {tab === "review" && playlistId && (
              <div className="mt-6 border-t border-[var(--border)] pt-5">
                <h3 className="mb-3 font-semibold">Retained copy recovery</h3>
                <PlaylistCopyReceipts
                  embedded
                  playlistId={playlistId}
                  onClose={onClose}
                />
              </div>
            )}
          </>
        )}
      </div>
    </PlaylistSyncFrame>
  )
}
