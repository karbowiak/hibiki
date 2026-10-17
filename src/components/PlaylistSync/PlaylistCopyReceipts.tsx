import { useEffect, useRef, useState } from "react"
import { PlaylistSyncFrame } from "./PlaylistSyncFrame"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
import { useProviderStore } from "../../stores/providerStore"
import {
  samePlaylistIdentity,
  reconcilePlaylistAttempt,
  dismissUnknownPlaylistAttempt,
  PlaylistCopyError,
  type PlaylistAttempt,
} from "../../playlistSync"
import { playlistCopyServices, type PlaylistCopyServices } from "./services"
import { useCopyOwner } from "./useCopyOwner"
import { providerPlaylistAccount } from "../../playlistSync/provider"
const button =
  "rounded-lg border border-(--border) bg-app-surface px-3 py-2 text-sm hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
function accountLabel(attempt: PlaylistAttempt) {
  return attempt.account.service === "listenbrainz"
    ? `ListenBrainz: ${attempt.account.user}`
    : `Music library (${attempt.account.service.replace(/^library:/, "")})`
}
export function PlaylistCopyReceipts({
  onClose,
  embedded = false,
  playlistId,
  services = playlistCopyServices,
}: {
  onClose(): void
  embedded?: boolean
  playlistId?: string
  services?: PlaylistCopyServices
}) {
  const authenticated = useListenBrainzStore((s) => s.isAuthenticated),
    username = useListenBrainzStore((s) => s.username)
  const provider = useProviderStore((s) => s.provider),
    capture = useCopyOwner(provider, "receipts")
  const [items, setItems] = useState<PlaylistAttempt[]>([]),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0)
  useEffect(() => {
    const current = capture()
    setLoading(true)
    setError(null)
    void Promise.all([
      services.journal.list(),
      playlistId ? services.account() : Promise.resolve(null),
    ])
      .then(([value, remoteAccount]) => {
        if (!current()) return
        const libraryAccount = provider
          ? providerPlaylistAccount(provider)
          : null
        setItems(
          [...value]
            .filter((item) => {
              if (!playlistId) return true
              const sourceOwned =
                (libraryAccount &&
                  samePlaylistIdentity(item.sourceAccount, libraryAccount)) ||
                (remoteAccount &&
                  samePlaylistIdentity(item.sourceAccount, remoteAccount))
              const targetOwned =
                (libraryAccount &&
                  samePlaylistIdentity(item.account, libraryAccount)) ||
                (remoteAccount &&
                  samePlaylistIdentity(item.account, remoteAccount))
              return (
                (sourceOwned && item.sourcePlaylistId === playlistId) ||
                (targetOwned && item.destinationId === playlistId)
              )
            })
            .sort((a, b) => b.createdAt - a.createdAt)
        )
      })
      .catch(() => {
        if (current())
          setError(
            "Could not read retained copy receipts. Local storage may be unavailable."
          )
      })
      .finally(() => {
        if (current()) setLoading(false)
      })
  }, [
    services,
    capture,
    retry,
    playlistId,
    provider,
    provider?.cacheScope,
    provider?.playbackSession,
    authenticated,
    username,
  ])
  return (
    <PlaylistSyncFrame
      embedded={embedded}
      title="Review playlist copies"
      description="Checking a receipt only reads the destination. It never repeats a create request."
      onClose={onClose}
    >
      {loading && <p role="status">Loading retained receipts…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            className={`${button} mt-2`}
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry loading receipts
          </button>
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <p>No playlist copy receipts yet.</p>
      )}
      <ul className="space-y-3">
        {items.map((attempt) => (
          <li key={attempt.id}>
            <Receipt
              attempt={attempt}
              services={services}
              capture={capture}
              onVerified={(updated) =>
                setItems((previous) =>
                  previous.map((item) =>
                    item.id === updated.id ? updated : item
                  )
                )
              }
            />
          </li>
        ))}
      </ul>
    </PlaylistSyncFrame>
  )
}
function Receipt({
  attempt,
  services,
  capture,
  onVerified,
}: {
  attempt: PlaylistAttempt
  services: PlaylistCopyServices
  capture: () => () => boolean
  onVerified(attempt: PlaylistAttempt): void
}) {
  const [acknowledged, setAcknowledged] = useState(false),
    [dismissalFailed, setDismissalFailed] = useState(false)
  const [id, setId] = useState(attempt.destinationId ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [choices, setChoices] = useState<{ id: string; title: string }[]>([]),
    [page, setPage] = useState(0),
    [more, setMore] = useState(false)
  const pending = useRef(false),
    active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  async function browse(offset = 0) {
    if (pending.current) return
    const current = capture()
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const provider = useProviderStore.getState().provider
      if (attempt.account.service === "listenbrainz") {
        const account = await services.account()
        if (!current() || !samePlaylistIdentity(account, attempt.account))
          throw Error("Original account required")
        const result = await services
          .listenBrainz(account)
          .list(offset * 50, 50)
        if (active.current && current()) {
          setChoices(result.items)
          setPage(offset)
          setMore((offset + 1) * 50 < result.total)
        }
      } else {
        if (
          !provider ||
          !samePlaylistIdentity(
            await services.library(provider).account(),
            attempt.account
          )
        )
          throw Error("Original library required")
        const result = await provider.getPlaylists()
        if (active.current && current()) {
          setChoices(result.slice(offset * 50, (offset + 1) * 50))
          setPage(offset)
          setMore((offset + 1) * 50 < result.length)
        }
      }
    } catch {
      if (active.current && current())
        setError(
          "Could not browse destinations. Connect the original account and try again."
        )
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }
  async function verify() {
    if (!id.trim() || pending.current) return
    const current = capture()
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const provider = useProviderStore.getState().provider
      const target =
        attempt.account.service === "listenbrainz"
          ? services.listenBrainz(await services.account())
          : provider
            ? services.library(provider)
            : null
      if (!target || !current()) return
      const verified = await reconcilePlaylistAttempt(
        attempt,
        target,
        services.journal,
        id.trim()
      )
      if (active.current && current()) onVerified(verified)
    } catch {
      if (active.current && current())
        setError(
          "Could not verify and retain this copy. Connect the original account, check the playlist’s ordered songs and retry."
        )
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }
  async function dismiss() {
    if (!acknowledged || pending.current) return
    const current = capture()
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const provider = useProviderStore.getState().provider
      const target =
        attempt.account.service === "listenbrainz"
          ? services.listenBrainz(await services.account())
          : provider
            ? services.library(provider)
            : null
      if (!target || !current()) return
      const dismissed = await dismissUnknownPlaylistAttempt(
        attempt,
        target,
        services.journal,
        current,
        acknowledged
      )
      if (active.current && current()) {
        setDismissalFailed(false)
        onVerified(dismissed)
      }
    } catch (failure) {
      if (active.current && current()) {
        setDismissalFailed(failure instanceof PlaylistCopyError)
        setError(
          failure instanceof PlaylistCopyError
            ? "The local dismissal could not be saved. Retry local retention; no remote request was sent."
            : "Could not dismiss this receipt. Connect the original account and review it again."
        )
      }
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }
  const settled =
    attempt.state === "verified" ||
    attempt.state === "cancelled" ||
    attempt.state === "dismissed"
  return (
    <article className="rounded-lg border border-(--border) bg-app-surface p-3">
      <p className="font-medium">{attempt.title}</p>
      <p className="text-sm text-(--text-secondary)">
        {accountLabel(attempt)} · {attempt.expectedTrackIds.length} ordered
        occurrences
      </p>
      <p className="mt-2 text-sm">
        {attempt.state === "verified"
          ? "Ordered songs verified."
          : attempt.state === "cancelled"
            ? "Cancelled before a request was sent."
            : attempt.state === "dismissed"
              ? "Dismissed locally after review. The remote outcome was not confirmed."
              : attempt.destinationId
                ? "Created copy needs verification."
                : "The create outcome is unknown. Inspect the original account before making another copy."}
      </p>
      {!settled && (
        <div className="mt-3 space-y-2">
          <label className="block text-sm">
            Destination playlist ID
            <input
              className="mt-1 w-full rounded-lg border border-(--border) bg-app-card px-3 py-2"
              value={id}
              maxLength={500}
              disabled={busy || !!attempt.destinationId}
              onChange={(event) => setId(event.target.value)}
              placeholder={
                attempt.account.service === "listenbrainz"
                  ? "ListenBrainz playlist UUID"
                  : "Playlist ID from this library"
              }
            />
          </label>
          <p className="text-xs text-(--text-secondary)">
            Choose the exact playlist after checking its title and order.
            Similar titles alone cannot identify an uncertain copy.
          </p>
          {!attempt.destinationId && (
            <>
              <button
                className={button}
                disabled={busy}
                onClick={() => void browse()}
              >
                Browse destination playlists
              </button>
              {choices.length > 0 && (
                <ul className="max-h-48 space-y-1 overflow-y-auto">
                  {choices.map((choice) => (
                    <li key={choice.id}>
                      <button
                        className={`${button} w-full text-left`}
                        disabled={busy}
                        onClick={() => setId(choice.id)}
                      >
                        {choice.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {choices.length > 0 && (
                <div className="flex gap-2">
                  <button
                    className={button}
                    disabled={busy || page === 0}
                    onClick={() => void browse(page - 1)}
                  >
                    Previous destinations
                  </button>
                  <button
                    className={button}
                    disabled={busy || !more}
                    onClick={() => void browse(page + 1)}
                  >
                    More destinations
                  </button>
                </div>
              )}
            </>
          )}
          <button
            className={button}
            disabled={busy || !id.trim()}
            onClick={() => void verify()}
          >
            {busy ? "Checking and saving…" : "Verify this copy"}
          </button>
          {!attempt.destinationId && (
            <div className="mt-4 border-t border-(--border) pt-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={busy}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                I inspected the original account. This copy may already exist,
                and trying again could create a duplicate.
              </label>
              <button
                className={`${button} mt-2`}
                disabled={busy || !acknowledged}
                onClick={() => void dismiss()}
              >
                {dismissalFailed
                  ? "Retry local dismissal"
                  : "Dismiss this local blocker"}
              </button>
              <p className="mt-1 text-xs text-(--text-secondary)">
                The receipt stays in local history. This does not delete a
                playlist or send another create request.
              </p>
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm">
          {error}
        </p>
      )}
    </article>
  )
}
