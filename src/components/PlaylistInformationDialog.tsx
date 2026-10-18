import { Button } from "./shared/Button"
import { useEffect, useState, type ReactNode } from "react"
import { AppDialog } from "./shared/AppDialog"
import { ArtworkImage } from "./shared/ArtworkImage"
import { RichText } from "./RichText"
import { formatTotalMs } from "../lib/formatters"
import { playlistNeedsReview } from "../lib/syncAttention"
import {
  captureDownloadOwner,
  ownsDownloads,
  refreshDownloadStatuses,
} from "../offline/downloadStatusStore"
import {
  createEntityDownloads,
  type DownloadIssue,
  type EntityDownloadStatus,
} from "../offline/downloadEntities"
import { useProviderStore } from "../stores/providerStore"
import type { MusicPlaylist } from "../types/music"
import type { LinkedPlaylist } from "../playlistSync/linked"

export function PlaylistInformationDialog({
  playlist,
  downloads,
  link,
  syncError,
  onClose,
  onReviewSync,
  sourceLabel,
  syncContent,
  downloadsSupported = true,
  downloadControls,
}: {
  playlist: MusicPlaylist
  downloads?: EntityDownloadStatus
  link?: LinkedPlaylist
  syncError?: string | null
  onClose: () => void
  onReviewSync: () => void
  sourceLabel?: string
  syncContent?: ReactNode
  downloadsSupported?: boolean
  downloadControls?: {
    issues: DownloadIssue[]
    loadMore?(): void
    retry(): void
    remove(): void
    busy: boolean
    disabled?: boolean
  }
}) {
  const provider = useProviderStore((state) => state.provider)
  const [owner] = useState(() => ({
    provider,
    session: provider?.playbackSession,
  }))
  const [issues, setIssues] = useState<DownloadIssue[]>([]),
    [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  useEffect(
    () =>
      useProviderStore.subscribe((state) => {
        if (
          state.provider !== owner.provider ||
          state.provider?.playbackSession !== owner.session
        )
          onClose()
      }),
    [owner, onClose]
  )
  useEffect(() => setOffset(0), [downloads?.failed])
  useEffect(() => {
    if (downloadControls) return
    const captured = captureDownloadOwner()
    if (!captured || !downloads?.failed) {
      setIssues([])
      setTotal(0)
      setLoading(false)
      setError("")
      return
    }
    let active = true
    setLoading(true)
    setError("")
    const api = createEntityDownloads(
      captured,
      () => active && ownsDownloads(captured)
    )
    void api
      .issues("playlist", playlist.id, offset)
      .then(
        (result) => {
          if (active) {
            setIssues((previous) =>
              offset
                ? [...previous.slice(0, offset), ...result.items]
                : result.items
            )
            setTotal(result.total)
          }
        },
        () => {
          if (active) setError("Could not load download details. Try again.")
        }
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [playlist.id, downloads?.failed, offset, revision, !!downloadControls])
  async function retryDownloads() {
    const captured = captureDownloadOwner()
    if (!captured || busy) return
    setBusy(true)
    setError("")
    try {
      await createEntityDownloads(captured, () =>
        ownsDownloads(captured)
      ).download("playlist", playlist.id)
      if (ownsDownloads(captured)) {
        refreshDownloadStatuses()
        setOffset(0)
        setRevision((value) => value + 1)
      }
    } catch {
      if (ownsDownloads(captured))
        setError(
          "Could not retry these downloads. Check Plex and available storage."
        )
    } finally {
      if (ownsDownloads(captured)) setBusy(false)
    }
  }
  const missing = link?.incomplete?.missingOccurrenceIds ?? []
  const missingSet = new Set(missing)
  const unmatched =
    link?.incomplete?.sourceSnapshot.items.filter((item) =>
      missingSet.has(item.occurrenceId)
    ) ?? []
  return (
    <AppDialog
      title={playlist.title}
      description="Playlist information"
      onClose={onClose}
      className="max-w-2xl"
      cover={
        playlist.thumbUrl ? (
          <ArtworkImage
            src={playlist.thumbUrl}
            alt=""
            className="h-14 w-14 shrink-0 rounded-lg object-cover"
          />
        ) : undefined
      }
    >
      <div className="space-y-6">
        <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
          {sourceLabel && (
            <div>
              <dt className="text-(--text-secondary)">Source</dt>
              <dd className="mt-1 font-medium">{sourceLabel}</dd>
            </div>
          )}
          <div>
            <dt className="text-(--text-secondary)">Songs</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {playlist.trackCount.toLocaleString()}
            </dd>
          </div>
          {!!playlist.duration && (
            <div>
              <dt className="text-(--text-secondary)">Runtime</dt>
              <dd className="mt-1 font-medium tabular-nums">
                {formatTotalMs(playlist.duration)}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-(--text-secondary)">Type</dt>
            <dd className="mt-1 font-medium">
              {playlist.smart ? "Smart playlist" : "Playlist"}
            </dd>
          </div>
        </dl>
        {playlist.summary && (
          <RichText
            html={playlist.summary}
            className="text-sm leading-relaxed text-(--text-secondary)"
          />
        )}
        {downloadsSupported && (
          <section
            aria-labelledby="playlist-download-heading"
            className="border-t border-(--border) pt-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 id="playlist-download-heading" className="font-semibold">
                Offline downloads
              </h3>
              {!!downloads?.requested && !!downloads.failed && (
                <Button
                  size="md"
                  variant="secondary"
                  className="media-secondary shell-control-secondary text-sm"
                  disabled={
                    downloadControls
                      ? downloadControls.busy || downloadControls.disabled
                      : busy || provider?.isOffline
                  }
                  onClick={() =>
                    downloadControls
                      ? downloadControls.retry()
                      : void retryDownloads()
                  }
                >
                  {busy ? "Queueing…" : "Retry downloads"}
                </Button>
              )}
            </div>
            <p className="mt-2 text-sm text-(--text-secondary)">
              {downloads?.requested
                ? `${downloads.downloaded.toLocaleString()} of ${downloads.total.toLocaleString()} songs saved${downloads.pending ? ` · ${downloads.pending} downloading or paused` : ""}${downloads.failed ? ` · ${downloads.failed} failed` : ""}.${downloadControls ? "" : " New songs are checked at startup and hourly while connected."}`
                : "This playlist is not set to stay downloaded."}
            </p>
            {downloadControls && downloads?.requested && (
              <Button
                className="mt-3"
                disabled={downloadControls.busy}
                onClick={downloadControls.remove}
              >
                {downloads.pending
                  ? "Cancel and remove downloads"
                  : "Remove downloads"}
              </Button>
            )}
            {(downloadControls?.issues ?? issues).length > 0 && (
              <ul className="mt-4 divide-y divide-(--border)">
                {(downloadControls?.issues ?? issues).map((issue, index) => (
                  <li key={`${issue.trackId}:${index}`} className="py-3">
                    <p className="text-sm font-medium">
                      {issue.title}
                      {issue.artist && (
                        <span className="font-normal text-(--text-secondary)">
                          {" "}
                          · {issue.artist}
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-(--text-secondary)">
                      {issue.error}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {loading && (
              <p role="status" className="mt-3 text-sm text-(--text-secondary)">
                Loading download details…
              </p>
            )}
            {(downloadControls ? downloadControls.issues.length < (downloads?.failed ?? 0) : issues.length < total) && !loading && (
              <Button
                size="md"
                variant="secondary"
                className="media-secondary shell-control-secondary mt-3 text-sm"
                disabled={downloadControls?.busy}
                onClick={() => downloadControls ? downloadControls.loadMore?.() : setOffset(issues.length)}
              >
                Show more issues
              </Button>
            )}
          </section>
        )}
        {syncContent ? (
          <section className="border-t border-(--border) pt-5">
            <h3 className="mb-3 font-semibold">Playlist sync</h3>
            {syncContent}
          </section>
        ) : (
          <section
            aria-labelledby="playlist-sync-heading"
            className="border-t border-(--border) pt-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 id="playlist-sync-heading" className="font-semibold">
                Playlist sync
              </h3>
              {link && (
                <Button
                  size="md"
                  variant="secondary"
                  className="media-secondary shell-control-secondary text-sm"
                  onClick={onReviewSync}
                >
                  Open Sync review
                </Button>
              )}
            </div>
            <p className="mt-2 text-sm text-(--text-secondary)">
              {syncError ||
                (link
                  ? playlistNeedsReview(link)
                    ? "Some songs or changes need review."
                    : link.paused || !link.enabled
                      ? "Automatic sync is paused."
                      : "This playlist is connected to ListenBrainz."
                  : "No playlist sync is configured.")}
            </p>
            {link?.message && (
              <p className="mt-2 text-sm leading-relaxed text-(--text-secondary)">
                {link.message}
              </p>
            )}
            {unmatched.length > 0 && (
              <>
                <h4 className="mt-4 text-sm font-medium">
                  {unmatched.length.toLocaleString()} unmatched{" "}
                  {unmatched.length === 1 ? "song" : "songs"}
                </h4>
                <ul className="mt-2 space-y-2 text-sm text-(--text-secondary)">
                  {unmatched.slice(0, 8).map((item) => (
                    <li key={item.occurrenceId}>
                      {item.track.title} · {item.track.artist}
                    </li>
                  ))}
                </ul>
                {unmatched.length > 8 && (
                  <p className="mt-2 text-sm text-(--text-secondary)">
                    Open Sync review to see all unmatched songs and choose their
                    matches.
                  </p>
                )}
              </>
            )}
          </section>
        )}
        {error && (
          <p role="alert" className="text-sm text-(--text-primary)">
            {error}{" "}
            <Button
              variant="bare"
              className="underline"
              onClick={() => setRevision((value) => value + 1)}
            >
              Try again
            </Button>
          </p>
        )}
      </div>
    </AppDialog>
  )
}
