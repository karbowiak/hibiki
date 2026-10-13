import { useEffect, useRef, useState } from "react"
import { AppDialog } from "../shared/AppDialog"
import { OccurrenceResolver } from "./PlaylistCopyDialog"
import { useCopyOwner } from "./useCopyOwner"
import { useProviderStore } from "../../stores/providerStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
import { useLinkedPlaylistStore } from "../../stores/linkedPlaylistStore"
import {
  nativeListenBrainzPlaylists,
  listenBrainzPlaylistAdapter,
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
import type { MusicProvider } from "../../providers/types"
import type { MusicPlaylist } from "../../types/music"
const button =
  "rounded-lg border border-[var(--border)] bg-app-surface px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
export interface LinkedPlaylistManagerServices {
  account(): Promise<PlaylistAccount>
  library(provider: MusicProvider, link?: LinkedPlaylist): PlaylistAdapter
  remote(account: PlaylistAccount): PlaylistAdapter & {
    list(
      offset?: number,
      count?: number
    ): Promise<{ items: PlaylistSnapshot[]; total: number }>
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
}
interface Preview {
  library: PlaylistSnapshot
  remote: PlaylistSnapshot
  source: SyncSide
  plan: PlaylistPlan
  existing?: LinkedPlaylist
}
export function LinkedPlaylistManager({
  playlistId,
  onClose,
  services = linkedPlaylistManagerServices,
}: {
  playlistId?: string
  onClose(): void
  services?: LinkedPlaylistManagerServices
}) {
  const provider = useProviderStore((s) => s.provider),
    authenticated = useListenBrainzStore((s) => s.isAuthenticated),
    username = useListenBrainzStore((s) => s.username)
  const capture = useCopyOwner(provider, `linked:${playlistId ?? ""}`)
  const [links, setLinks] = useState<LinkedPlaylist[]>([]),
    [libraries, setLibraries] = useState<MusicPlaylist[]>([]),
    [remotes, setRemotes] = useState<PlaylistSnapshot[]>([])
  const [libraryId, setLibraryId] = useState(playlistId ?? ""),
    [remoteId, setRemoteId] = useState(""),
    [source, setSource] = useState<SyncSide>("library"),
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
  const admission = useRef(false),
    request = useRef(0),
    lease = useRef<PlaylistAccount | null>(null)
  const [recoveryViews, setRecoveryViews] = useState<
    Record<string, PlaylistSnapshot>
  >({})
  const [recoveryApproval, setRecoveryApproval] = useState<
    Record<string, boolean>
  >({})
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
          services.remote(account).list(page * 50, 50),
          services.repository.load(),
        ])
        if (!owns() || revision !== request.current) return
        lease.current = account
        setLibraries(local.filter((item) => !item.smart))
        setRemotes(remote.items)
        setTotal(remote.total)
        setOtherLinks(
          stored.filter(
            (link) =>
              !samePlaylistIdentity(
                link.library,
                providerPlaylistAccount(provider)
              ) && samePlaylistIdentity(link.listenbrainz, account)
          )
        )
        setLinks(
          stored.filter(
            (link) =>
              samePlaylistIdentity(
                link.library,
                providerPlaylistAccount(provider)
              ) && samePlaylistIdentity(link.listenbrainz, account)
          )
        )
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
  ])
  async function rebind(link: LinkedPlaylist, commit = false) {
    if (
      !provider ||
      admission.current ||
      link.job?.step ||
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
      const direction = source === "library" ? "export" : "import",
        sourceSnapshot = source === "library" ? library : remote,
        target = source === "library" ? remote.account : library.account
      const plan = planPlaylistCopy(sourceSnapshot, target, {
        direction,
        candidates: library.items.map((item) => item.track),
      })
      setPreview({ library, remote, source, plan, existing })
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
  async function enable() {
    if (!provider || !preview || !approved || admission.current) return
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
        playlistContent(library) !== playlistContent(preview.library) ||
        playlistContent(remote) !== playlistContent(preview.remote)
      )
        throw Error("Preview changed")
      if (existing?.job?.step)
        throw Error("Reconcile the retained operation first")
      const mappings: LinkedTrackMapping[] = rows.map((row, index) => ({
        libraryTrack: preview.source === "library" ? row.source : tracks[index],
        recordingMbid: recordingMbid(
          preview.source === "library"
            ? tracks[index].recordingMbid
            : row.source.recordingMbid
        )!,
        verifiedBy: "reviewed",
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
        enabled: true,
        paused: false,
        state: "ready",
        message: undefined,
        baseline: { library, listenbrainz: remote },
        baselineHashes: {
          library: await playlistContentHash(library),
          listenbrainz: await playlistContentHash(remote),
        },
        mappings: [...(existing?.mappings ?? []), ...mappings].filter(
          (mapping, index, all) =>
            all.findIndex(
              (other) =>
                other.libraryTrack.id === mapping.libraryTrack.id &&
                other.recordingMbid === mapping.recordingMbid
            ) === index
        ),
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
      const retained = await save({ ...link, paused, enabled }, link.revision)
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
            destination = job.source === "library" ? "listenbrainz" : "library",
            actual = await sync[destination].read(job.step!.before.id)
          if (!owns()) return
          setRecoveryViews((previous) => ({ ...previous, [link.id]: actual }))
          setRecoveryApproval((previous) => ({ ...previous, [link.id]: false }))
          if (
            JSON.stringify(actual.items.map((item) => item.track.id)) !==
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
  const unsupported =
    !provider ||
    provider.isOffline ||
    !provider.mutatePlaylistOccurrence ||
    !authenticated
  return (
    <AppDialog
      title="Linked playlist sync"
      description="Explicitly link two playlists. Ordered duplicates are preserved; both-sided edits require review."
      onClose={onClose}
      canClose={!busy}
    >
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        Track membership and order sync while Hibiki is running and online.
        Names, privacy and collaborators stay independent. Services do not
        support atomic compare-and-swap; external edits during an update can
        require recovery. Last.fm playlist syncing is unavailable.
      </p>
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
                disabled={busy}
                onClick={() => setRetry((value) => value + 1)}
              >
                Reload settings
              </button>
            </div>
          )}
          {busy && <p role="status">Reading or retaining playlist state…</p>}
          {!preview && (
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
                    disabled={busy}
                    onChange={(event) => setLibraryId(event.target.value)}
                  >
                    <option value="">Choose a regular playlist</option>
                    {libraries.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  ListenBrainz playlist
                  <select
                    className={`${button} mt-1 w-full`}
                    value={remoteId}
                    disabled={busy}
                    onChange={(event) => setRemoteId(event.target.value)}
                  >
                    <option value="">Choose your playlist</option>
                    {remotes.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {total > 50 && (
                <div className="flex gap-2">
                  <button
                    className={button}
                    disabled={busy || page === 0}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    Previous playlists
                  </button>
                  <button
                    className={button}
                    disabled={busy || (page + 1) * 50 >= total}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Next playlists
                  </button>
                </div>
              )}
              <label className="block text-sm">
                Initial version to keep
                <select
                  className={`${button} ml-2`}
                  value={source}
                  disabled={busy}
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
                disabled={busy || !libraryId || !remoteId}
                onClick={() => void prepare()}
              >
                Preview link
              </button>
            </section>
          )}
          {preview && (
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
                version will update the other playlist. Confirm every recording;
                unknown matches are never guessed.
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
              <ol className="max-h-[45vh] space-y-3 overflow-auto">
                {preview.plan.rows.map((row, index) => (
                  <li key={row.occurrenceId}>
                    <OccurrenceResolver
                      index={index}
                      row={row}
                      mode={preview.source === "library" ? "export" : "import"}
                      disabled={busy}
                      provider={provider}
                      current={capture}
                      onResolve={(track) =>
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
                          disabled={busy}
                          onClick={() => {
                            if (row.match.status !== "matched" || !capture()())
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
                  disabled={busy}
                  onChange={(event) => setApproved(event.target.checked)}
                />
                I reviewed the ordered songs and explicitly enable ongoing
                bidirectional updates for these accounts.
              </label>
              <div className="flex gap-2">
                <button
                  className={button}
                  disabled={busy || !approved}
                  onClick={() => void enable()}
                >
                  Enable linked sync
                </button>
                <button
                  className={button}
                  disabled={busy}
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
                    !link.job?.step &&
                    services.repository.rebind ? (
                      <button
                        className={button}
                        disabled={busy}
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
                {rebindView.remote.account.user}. This records a new connection
                identity only; it does not update either service. Any incomplete
                confirmed plan is stopped and must be previewed again.
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
                  disabled={busy}
                  onChange={(event) => setRebindApproved(event.target.checked)}
                />
                I confirm this is my original Plex account, server and music
                library and reviewed the current playlist.
              </label>
              <button
                className={button}
                disabled={busy || !rebindApproved}
                onClick={() => void rebind(rebindView.link, true)}
              >
                Retain reviewed connection
              </button>
            </section>
          )}
          <section
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
                    {link.baseline.library.title} ↔{" "}
                    {link.baseline.listenbrainz.title}
                  </h3>
                  <p className="mt-1 text-sm">
                    {link.listenbrainz.user} ·{" "}
                    {!link.enabled
                      ? "Disabled"
                      : link.paused
                        ? "Paused"
                        : link.job
                          ? `Syncing · ${link.job.completedSteps} verified steps`
                          : "Enabled"}
                  </p>
                  {link.message && (
                    <p className="mt-1 text-sm" role="status">
                      {link.message}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() => void settings(link, true, false)}
                    >
                      Disable
                    </button>
                    {link.enabled && !link.paused && (
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => void settings(link, true)}
                      >
                        Pause
                      </button>
                    )}
                    {link.enabled && !link.paused && (
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => void check(link)}
                      >
                        Check now
                      </button>
                    )}
                    {link.job?.step ? (
                      <>
                        {recoveryViews[link.id] && (
                          <div className="basis-full rounded-lg border border-[var(--border)] p-3">
                            <p className="text-sm font-medium">
                              Current destination order ·{" "}
                              {recoveryViews[link.id].items.length} occurrences
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
                            <p className="mt-2 text-xs text-[var(--text-secondary)]">
                              The earlier request may have applied. Retaining
                              this review records the uncertain intent and
                              pauses updates; a new ordered preview is required
                              before another write.
                            </p>
                          </div>
                        )}
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            disabled={busy || !recoveryViews[link.id]}
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
                          disabled={busy}
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
                        disabled={busy}
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
        </>
      )}
    </AppDialog>
  )
}
