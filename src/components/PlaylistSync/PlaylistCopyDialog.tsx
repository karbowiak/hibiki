import { useEffect, useRef, useState } from "react"
import { open } from "@tauri-apps/plugin-shell"
import { useProviderStore } from "../../stores/providerStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
import { VerifiedRecordingsAction } from "./VerifiedRecordingsAction"
import { PlaylistSyncFrame } from "./PlaylistSyncFrame"
import { Skeleton } from "../shared/Skeleton"
import {
  executePlaylistCopy,
  PlaylistCopyApproval,
  PlaylistCopyError,
  planPlaylistCopy,
  playlistCopyBlockReason,
  resolvePlaylistOccurrence,
  recordingMbid,
  playlistTrackFromMusic,
  type PlaylistPlan,
  type PlaylistAdapter,
  type PlaylistSnapshot,
  type PlaylistAttempt,
  type PlaylistTrack,
} from "../../playlistSync"
import { playlistCopyServices, type PlaylistCopyServices } from "./services"
import { useCopyOwner } from "./useCopyOwner"
import {
  playlistSearchQuery,
  filterPlaylistCandidates,
} from "../../playlistSync/manualSearch"

const button =
  "rounded-lg border border-[var(--border)] bg-app-surface px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
const input =
  "w-full rounded-lg border border-[var(--border)] bg-app-surface px-3 py-2 text-sm text-[var(--text-primary)] focus:outline focus:outline-2 focus:outline-accent"
interface Props {
  mode: "import" | "export"
  suggestedTitle?: string
  remotePlaylistId?: string
  embedded?: boolean
  onBusyChange?(busy: boolean): void
  playlistId?: string
  onClose(): void
  onCreated?(attempt: PlaylistAttempt): void | Promise<void>
  services?: PlaylistCopyServices
}
export function PlaylistCopyDialog({
  mode,
  suggestedTitle,
  remotePlaylistId,
  embedded = false,
  onBusyChange,
  playlistId,
  onClose,
  onCreated,
  services = playlistCopyServices,
}: Props) {
  const provider = useProviderStore((s) => s.provider)
  const authenticated = useListenBrainzStore((s) => s.isAuthenticated)
  const username = useListenBrainzStore((s) => s.username)
  const capture = useCopyOwner(
    provider,
    `${mode}:${playlistId ?? ""}:${remotePlaylistId ?? ""}`
  )
  const [sourceAdapter, setSourceAdapter] = useState<PlaylistAdapter | null>(
    null
  )
  const [targetAdapter, setTargetAdapter] = useState<PlaylistAdapter | null>(
    null
  )
  const [choices, setChoices] = useState<PlaylistSnapshot[]>([])
  const [page, setPage] = useState(0),
    [total, setTotal] = useState(0)
  const [plan, setPlan] = useState<PlaylistPlan | null>(null)
  const [title, setTitle] = useState("")
  const [loading, setLoading] = useState(false),
    [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null),
    [result, setResult] = useState<PlaylistAttempt | null>(null)
  const [unretained, setUnretained] = useState<PlaylistAttempt | null>(null)
  const [resolving, setResolving] = useState(false)
  const [retry, setRetry] = useState(0)
  const revision = useRef(0),
    selectionPending = useRef<symbol | null>(null),
    admission = useRef(false),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    onBusyChange?.(committing || !!unretained)
    return () => onBusyChange?.(false)
  }, [committing, unretained, onBusyChange])
  const ready =
    !!provider?.capabilities.playlists &&
    !!provider.cacheScope &&
    authenticated &&
    !!username

  async function preview(
    source: PlaylistSnapshot,
    target: PlaylistAdapter,
    current: () => boolean
  ) {
    const account = await target.account()
    if (!current()) return
    let candidates: PlaylistTrack[] = []
    if (mode === "import" && provider?.capabilities.search) {
      // Only bounded title/artist searches; never scan or sync the complete library.
      const unique = [
        ...new Map(
          source.items.map((item) => [
            JSON.stringify([
              item.track.artist,
              item.track.title,
              item.track.album,
            ]),
            item.track,
          ])
        ).values(),
      ].slice(0, 30)
      let cursor = 0
      await Promise.all(
        Array.from({ length: Math.min(3, unique.length) }, async () => {
          while (current() && cursor < unique.length) {
            const track = unique[cursor++]
            if (!track.title.trim() || !track.artist.trim()) continue
            try {
              const matches = await provider.search(
                `${track.artist} ${track.title}`.slice(0, 500),
                "track"
              )
              if (!current()) return
              candidates.push(
                ...matches
                  .filter((item) => item.type === "track")
                  .slice(0, 50)
                  .map((track) => playlistTrackFromMusic(track))
              )
            } catch {
              /* A missing match remains explicit and can be searched again. */
            }
          }
        })
      )
      candidates = [
        ...new Map(candidates.map((track) => [track.id, track])).values(),
      ]
    }
    if (!current()) return
    const next = planPlaylistCopy(source, account, {
      direction: mode,
      candidates,
    })
    setPlan(next)
    setTitle(suggestedTitle ?? next.title)
    setResult(null)
  }

  useEffect(() => {
    const owns = capture(),
      request = ++revision.current
    const current = () => owns() && request === revision.current
    selectionPending.current = null
    setPlan(null)
    setChoices([])
    setError(null)
    setResult(null)
    setLoading(false)
    if (!ready || !provider) return
    setLoading(true)
    void (async () => {
      try {
        const account = await services.account()
        if (!current()) return
        if (account.service !== "listenbrainz" || account.user !== username)
          throw Error("ListenBrainz account changed")
        const lb = services.listenBrainz(account),
          library = services.library(provider)
        const source = mode === "import" ? lb : library,
          target = mode === "import" ? library : lb
        setSourceAdapter(source)
        setTargetAdapter(target)
        if (mode === "import" && remotePlaylistId) {
          await preview(await source.read(remotePlaylistId), target, current)
        } else if (mode === "import") {
          const response = await lb.list(page * 50, 50)
          if (current()) {
            setChoices(response.items)
            setTotal(response.total)
          }
        } else if (playlistId)
          await preview(await source.read(playlistId), target, current)
      } catch {
        if (current())
          setError(
            "Could not load playlist copies. Check your connection and try again."
          )
      } finally {
        if (current()) setLoading(false)
      }
    })()
    return () => {
      ++revision.current
    }
  }, [
    mode,
    playlistId,
    remotePlaylistId,
    suggestedTitle,
    provider,
    provider?.cacheScope,
    provider?.playbackSession,
    authenticated,
    username,
    page,
    retry,
    services,
    capture,
  ])

  async function choose(id: string) {
    if (!sourceAdapter || !targetAdapter || loading || selectionPending.current)
      return
    const pending = Symbol("selected playlist")
    selectionPending.current = pending
    const owns = capture(),
      request = ++revision.current,
      current = () => owns() && revision.current === request
    setLoading(true)
    setError(null)
    try {
      await preview(await sourceAdapter.read(id), targetAdapter, current)
    } catch {
      if (current())
        setError(
          "Could not read this playlist. It may exceed the 1,000-song limit. Try again."
        )
    } finally {
      if (selectionPending.current === pending) selectionPending.current = null
      if (current()) setLoading(false)
    }
  }
  async function commit() {
    if (
      !plan ||
      !sourceAdapter ||
      !targetAdapter ||
      admission.current ||
      !title.trim()
    )
      return
    admission.current = true
    const current = capture()
    setCommitting(true)
    setError(null)
    try {
      const approved = { ...plan, title: title.trim() }
      const receipt = await executePlaylistCopy(
        new PlaylistCopyApproval(approved),
        sourceAdapter,
        targetAdapter,
        services.journal,
        current
      )
      if (!current()) return
      setResult(receipt)
      if (receipt.state === "verified") {
        try {
          await onCreated?.(receipt)
        } catch {
          if (current())
            setError(
              "The copy was created and verified, but the library view could not refresh. Reload the playlist view; do not create another copy."
            )
        }
      }
    } catch (failure) {
      if (!current()) {
        if (
          mounted.current &&
          failure instanceof PlaylistCopyError &&
          failure.message.includes("receipt could not be saved")
        ) {
          setUnretained(failure.attempt)
          setError(
            "A previous account’s copy receipt could not be saved. Retry local retention before closing."
          )
        }
        return
      }
      if (failure instanceof PlaylistCopyError) {
        setResult(failure.attempt)
        if (failure.message.includes("receipt could not be saved"))
          setUnretained(failure.attempt)
        setError(failure.message)
      } else
        setError(
          "No copy was confirmed. The account, playlist or local storage may have changed. Preview again before continuing."
        )
    } finally {
      admission.current = false
      if (mounted.current) setCommitting(false)
    }
  }
  async function retain() {
    if (!unretained || admission.current) return
    const current = capture()
    admission.current = true
    setCommitting(true)
    try {
      await services.journal.save(unretained)
      if (current()) {
        setUnretained(null)
        setError("Receipt saved. Review the copy to confirm its ordered songs.")
      }
    } catch {
      if (current())
        setError(
          "The receipt could not be saved. Keep this dialog open and retry local retention."
        )
    } finally {
      admission.current = false
      if (mounted.current) setCommitting(false)
    }
  }
  const missing =
    plan?.rows.filter((row) => row.match.status !== "matched").length ?? 0
  const copyBlocked =
    plan && targetAdapter
      ? playlistCopyBlockReason(plan, targetAdapter.capabilities)
      : null
  return (
    <PlaylistSyncFrame
      embedded={embedded}
      title={
        mode === "import"
          ? "Import a playlist copy"
          : "Export a private playlist copy"
      }
      description="Review every song and its order. Existing playlists stay unchanged."
      onClose={onClose}
      canClose={!committing && !unretained}
      className="max-w-4xl"
      footer={
        <>
          {unretained ? (
            <button
              className={button}
              disabled={committing || resolving}
              onClick={() => void retain()}
            >
              Retry saving receipt
            </button>
          ) : !result && plan ? (
            <button
              className={button}
              disabled={
                loading ||
                resolving ||
                committing ||
                missing > 0 ||
                !!copyBlocked ||
                !title.trim() ||
                title.length > 500 ||
                !ready
              }
              onClick={() => void commit()}
            >
              {committing
                ? "Creating copy…"
                : mode === "import"
                  ? "Import this copy"
                  : "Export this private copy"}
            </button>
          ) : null}
        </>
      }
    >
      <p className="mb-3 text-sm text-[var(--text-secondary)]">
        {username
          ? `ListenBrainz: ${username}`
          : "ListenBrainz is disconnected"}{" "}
        · {provider?.name ?? "Music library disconnected"}
      </p>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        Last.fm does not support playlist import or export. This is an explicit
        copy, with no automatic background synchronization.
      </p>
      {!ready && (
        <p role="status">
          Connect ListenBrainz and an account-scoped music library with
          playlists in Settings.
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg bg-app-surface p-3 text-sm"
        >
          <p>{error}</p>
          {!committing && !unretained && !result && (
            <button
              className={`${button} mt-2`}
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry preview
            </button>
          )}
        </div>
      )}
      {loading && (
        <div
          role="status"
          aria-label="Loading playlist preview"
          className="space-y-3"
        >
          <p className="text-sm">
            Loading playlist and checking local matches…
          </p>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}
      {!loading && ready && !plan && (
        <>
          <ul className="space-y-2">
            {choices.map((choice) => (
              <li key={choice.id}>
                <button
                  className={`${button} w-full text-left`}
                  onClick={() => void choose(choice.id)}
                >
                  {choice.title}
                </button>
              </li>
            ))}
          </ul>
          {choices.length === 0 && !error && (
            <p>No ListenBrainz playlists on this page.</p>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button
              className={button}
              disabled={page === 0}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous page
            </button>
            <span className="text-sm">Page {page + 1}</span>
            <button
              className={button}
              disabled={(page + 1) * 50 >= total}
              onClick={() => setPage((value) => value + 1)}
            >
              Next page
            </button>
          </div>
        </>
      )}
      {plan && !loading && (
        <>
          <VerifiedRecordingsAction
            provider={provider}
            plan={plan}
            current={capture}
            disabled={committing || !!result || !!unretained}
            onRunning={setResolving}
            onResolved={(next) =>
              setPlan((previous) => (previous === plan ? next : previous))
            }
          />
          <label className="mb-4 block text-sm">
            Copy title
            <input
              className={`${input} mt-1`}
              maxLength={500}
              value={title}
              disabled={committing || resolving || !!result}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <p className="mb-3 text-sm text-[var(--text-secondary)]">
            {plan.rows.length} ordered occurrences · {missing} need review.
            Repeated songs remain separate in this preview.
          </p>
          {copyBlocked && (
            <p
              role="status"
              className="mb-3 text-sm text-[var(--text-secondary)]"
            >
              {copyBlocked}
            </p>
          )}
          <ol className="max-h-[48vh] space-y-3 overflow-y-auto pr-2">
            {plan.rows.map((row, index) => (
              <li key={row.occurrenceId}>
                <OccurrenceResolver
                  index={index}
                  row={row}
                  mode={mode}
                  disabled={committing || resolving || !!result}
                  provider={provider}
                  current={capture}
                  onResolve={(selected) =>
                    setPlan((previous) =>
                      previous
                        ? resolvePlaylistOccurrence(
                            previous,
                            row.occurrenceId,
                            selected
                          )
                        : previous
                    )
                  }
                />
              </li>
            ))}
          </ol>
        </>
      )}
      {result && (
        <div
          role="status"
          className="mt-4 rounded-lg bg-app-surface p-3 text-sm"
        >
          {result.state === "verified"
            ? "Copy created and its ordered songs verified."
            : result.state === "cancelled"
              ? "No request was sent."
              : "This copy needs checking. Open Sync, choose the original remote playlist and use Recover an earlier copy before retrying."}
        </div>
      )}
    </PlaylistSyncFrame>
  )
}

export function OccurrenceResolver({
  index,
  row,
  mode,
  disabled,
  provider,
  current,
  onResolve,
  evidenceLabel,
}: {
  index: number
  row: PlaylistPlan["rows"][number]
  mode: "import" | "export"
  disabled: boolean
  provider: ReturnType<typeof useProviderStore.getState>["provider"]
  current: () => () => boolean
  onResolve(track: PlaylistTrack): void
  evidenceLabel?: string
}) {
  const [query, setQuery] = useState(
      `${row.source.artist} ${row.source.title}`.slice(0, 256)
    ),
    [mbid, setMbid] = useState("")
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<PlaylistTrack[]>(
    row.match.status === "ambiguous" || row.match.status === "missing"
      ? [...row.match.candidates]
      : []
  )
  const request = useRef(0),
    searchPending = useRef<symbol | null>(null),
    active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      ++request.current
    }
  }, [])
  const canonical = recordingMbid(mbid)
  async function search() {
    const upstream = playlistSearchQuery(query)
    if (
      !provider?.capabilities.search ||
      !upstream ||
      busy ||
      searchPending.current
    )
      return
    const pending = Symbol("recording search")
    searchPending.current = pending
    const owns = current(),
      revision = ++request.current
    setBusy(true)
    setError(null)
    try {
      const found = await provider.search(upstream!, "track")
      if (!active.current || !owns() || request.current !== revision) return
      setCandidates(
        filterPlaylistCandidates(
          found
            .filter((item) => item.type === "track")
            .slice(0, 50)
            .map((track) => playlistTrackFromMusic(track)),
          query
        )
      )
    } catch {
      if (active.current && owns() && request.current === revision)
        setError("Could not search this library. Try again.")
    } finally {
      if (searchPending.current === pending) searchPending.current = null
      if (active.current && owns() && request.current === revision)
        setBusy(false)
    }
  }
  return (
    <article className="rounded-lg border border-[var(--border)] bg-app-surface p-3">
      <p className="font-medium">
        {index + 1}. {row.source.title || "Untitled recording"}
      </p>
      <p className="text-sm text-[var(--text-secondary)]">
        {row.source.artist || "Unknown artist"}
        {row.source.album ? ` · ${row.source.album}` : ""}
      </p>
      {row.match.status === "matched" ? (
        <p className="mt-2 text-sm">
          {evidenceLabel ??
            (row.match.by === "manual"
              ? "Explicitly selected"
              : row.match.by === "mbid"
                ? "Matched by recording ID"
                : "Matched by metadata")}
          : {row.match.track.artist} — {row.match.track.title}
          {row.match.track.album ? ` · ${row.match.track.album}` : ""}
        </p>
      ) : (
        <p className="mt-2 text-sm">
          {row.match.status === "ambiguous"
            ? "Multiple matches. Choose the correct recording."
            : mode === "export"
              ? "A verified recording MBID is required."
              : "No safe local match yet."}
        </p>
      )}
      {!disabled && mode === "export" && (
        <div className="mt-3 space-y-2">
          <label className="block text-sm">
            Recording MBID for occurrence {index + 1}
            <input
              className={`${input} mt-1`}
              value={mbid}
              onChange={(event) => {
                setMbid(event.target.value.trim())
                setConfirmed(false)
              }}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {canonical && (
            <a
              href={`https://musicbrainz.org/recording/${canonical}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-accent underline"
              onClick={(event) => {
                event.preventDefault()
                const owns = current()
                void open(
                  `https://musicbrainz.org/recording/${canonical}`
                ).catch(() => {
                  if (active.current && owns())
                    setError("Could not open MusicBrainz. Try again.")
                })
              }}
            >
              Verify artist and title on MusicBrainz
            </a>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!canonical}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I checked this recording’s artist and title.
          </label>
          <button
            className={button}
            disabled={!canonical || !confirmed}
            onClick={() =>
              onResolve({ ...row.source, recordingMbid: canonical })
            }
          >
            Use verified recording for occurrence {index + 1}
          </button>
        </div>
      )}
      {!disabled && mode === "import" && (
        <details className="mt-3" open={row.match.status !== "matched"}>
          <summary className="cursor-pointer text-sm">
            Choose a local recording
          </summary>
          <div className="mt-2 flex gap-2">
            <label className="flex-1 text-sm">
              Search occurrence {index + 1}
              <input
                className={`${input} mt-1`}
                value={query}
                maxLength={256}
                onChange={(event) => {
                  ++request.current
                  searchPending.current = null
                  setBusy(false)
                  setQuery(event.target.value)
                }}
              />
            </label>
            <button
              className={`${button} self-end`}
              disabled={
                busy ||
                !provider?.capabilities.search ||
                !playlistSearchQuery(query)
              }
              onClick={() => void search()}
            >
              {busy ? "Searching…" : "Search library"}
            </button>
          </div>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">
            Use * for several characters or ? for one character to narrow names.
            Include an artist or title; wildcard matches are suggestions and
            always require your explicit selection.
          </p>
          {candidates.length > 0 && (
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    className={`${button} w-full text-left`}
                    onClick={() => onResolve(candidate)}
                  >
                    {candidate.artist} — {candidate.title}
                    {candidate.album ? ` · ${candidate.album}` : ""}
                    {candidate.durationMs
                      ? ` · ${Math.round(candidate.durationMs / 1000)}s`
                      : ""}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!busy && candidates.length === 0 && (
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              No candidates shown. Search this library to choose a recording.
            </p>
          )}
        </details>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm">
          {error}
        </p>
      )}
    </article>
  )
}
