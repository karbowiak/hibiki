import { useEffect, useRef, useState } from "react"
import { Link } from "wouter"
import { useProviderStore } from "../../stores/providerStore"
import { usePlayerStore } from "../../stores/playerStore"
import { useContextMenu } from "../../hooks/useContextMenu"
import type { LocalAudioPage, LocalAudioItem } from "../../offline/audio"
import type { MusicProvider } from "../../providers/types"
import { ArtworkImage } from "../shared/ArtworkImage"
import {
  IconPlayerPlay,
  IconDownload,
  IconTrash,
  IconRefresh,
} from "@tabler/icons-react"

const PAGE_SIZE = 100
function bytes(value: number) {
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GB`
    : `${(value / 1024 ** 2).toFixed(1)} MB`
}
function status(item: LocalAudioItem) {
  if (item.status === "downloaded") return "Available offline"
  if (item.status === "cached") return "Cached · available offline"
  if (
    item.status === "downloading" &&
    item.total &&
    item.received >= item.total
  )
    return "Verifying audio…"
  if (item.status === "downloading")
    return item.total
      ? `${Math.min(100, Math.round((item.received * 100) / item.total))}% · ${bytes(item.received)} / ${bytes(item.total)}`
      : `Downloading · ${bytes(item.received)}`
  return {
    queued: "Queued",
    paused: "Paused · resumes when Plex reconnects",
    error: "Download failed",
    unavailable: "No longer stored on this device",
  }[item.status]
}

export function DownloadsPage() {
  const provider = useProviderStore((s) => s.provider)
  const [cached, setCached] = useState(false)
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<LocalAudioPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const [refresh, setRefresh] = useState(0)
  const epoch = useRef(0)
  const busy = useRef<{ provider: MusicProvider; ticket: symbol } | null>(null)
  const ctx = useContextMenu()
  useEffect(() => {
    setPage(null)
    setOffset(0)
    setError(null)
    setPending(null)
  }, [provider, cached])
  useEffect(() => {
    const owner = ++epoch.current
    let querying = false
    const load = async () => {
      if (
        querying ||
        !provider?.getLocalAudio ||
        busy.current?.provider === provider
      )
        return
      querying = true
      try {
        const result = await provider.getLocalAudio(offset, PAGE_SIZE, cached)
        if (epoch.current === owner) {
          setPage(result)
          setError(null)
        }
      } catch {
        if (epoch.current === owner)
          setError(
            "Could not load local music. Check storage permissions and try again."
          )
      } finally {
        querying = false
      }
    }
    void load()
    const timer = setInterval(() => void load(), 1500)
    return () => {
      ++epoch.current
      clearInterval(timer)
    }
  }, [provider, cached, offset, refresh])

  async function action(item: LocalAudioItem, kind: "retry" | "remove") {
    if (!provider || busy.current?.provider === provider) return
    const ticket = Symbol("download action")
    busy.current = { provider, ticket }
    const owner = epoch.current
    setPending(item.trackId)
    setError(null)
    try {
      if (kind === "remove")
        await provider.removeDownload?.(String(item.trackId))
      else await provider.downloadTracks?.([String(item.trackId)])
      if (epoch.current === owner) setRefresh((value) => value + 1)
    } catch {
      if (epoch.current === owner)
        setError(
          `Could not ${kind === "remove" ? "remove" : "queue"} this download. Try again.`
        )
    } finally {
      if (busy.current?.ticket === ticket) busy.current = null
      if (epoch.current === owner) setPending(null)
    }
  }

  return (
    <section className="pb-8">
      <div className="flex flex-wrap items-end justify-between gap-4 pb-6">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-secondary)]">
            Your music · on this device
          </p>
          <h1 className="text-4xl font-bold text-[var(--text-primary)]">
            Downloads
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-[var(--text-secondary)]">
            Downloaded music stays until you remove it. Played tracks are cached
            automatically and may be evicted to make space.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!page?.items.some((item) => item.available && item.track)}
            onClick={() => {
              const tracks =
                page?.items
                  .filter((item) => item.available && item.track)
                  .map((item) => item.track!) ?? []
              if (tracks[0])
                void usePlayerStore
                  .getState()
                  .playTrack(tracks[0], tracks, "Local music", "/downloads")
            }}
            className="rounded-full border border-transparent bg-[var(--artwork-primary,var(--accent))] px-4 py-2 text-sm font-medium text-[var(--artwork-ink,#111)] transition-colors hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
          >
            Play this page
          </button>
          <Link
            href="/settings/cache"
            className="rounded-full border border-[var(--border)] bg-app-surface px-4 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Storage settings
          </Link>
        </div>
      </div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-4">
        <div className="flex gap-2" role="group" aria-label="Local music view">
          {[
            { value: false, label: "Downloads" },
            { value: true, label: "Played & cached" },
          ].map((tab) => (
            <button
              key={tab.label}
              type="button"
              aria-pressed={cached === tab.value}
              onClick={() => {
                setPage(null)
                setOffset(0)
                setCached(tab.value)
              }}
              className={`${cached === tab.value ? "border border-transparent bg-[var(--artwork-primary,var(--accent))] text-[var(--artwork-ink,#111)] transition-colors hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" : "border border-[var(--border)] bg-app-surface text-[var(--text-primary)] transition-colors hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"} rounded-full px-4 py-2 text-sm font-medium`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {page && (
          <span className="text-xs text-[var(--text-secondary)]">
            {bytes(page.downloadedBytes)} downloaded
          </span>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-app-card p-4 text-sm text-[var(--text-primary)]"
        >
          {error}
          <button
            type="button"
            onClick={() => setRefresh((value) => value + 1)}
            className="rounded-lg border border-[var(--border)] bg-app-surface px-3 py-2 text-[var(--text-primary)] transition-colors hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Retry
          </button>
        </div>
      )}
      {!page && !error && (
        <p
          role="status"
          className="py-12 text-center text-[var(--text-secondary)]"
        >
          Loading local music…
        </p>
      )}
      {page?.total === 0 && (
        <div className="bg-app-card/60 rounded-2xl border border-[var(--border)] px-6 py-14 text-center">
          <IconDownload
            size={32}
            className="mx-auto mb-4 text-[var(--text-secondary)]"
          />
          <p className="font-semibold text-[var(--text-primary)]">
            {cached ? "No played tracks saved yet" : "Take your music with you"}
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-secondary)]">
            {cached
              ? "Complete audio files are saved automatically as you listen."
              : "Right-click a track, album or playlist and choose Download for offline playback."}
          </p>
        </div>
      )}
      <div className="divide-y divide-[var(--border)]">
        {page?.items.map((item) => (
          <div
            key={item.trackId}
            onContextMenu={
              item.track ? ctx.handler("track", item.track) : undefined
            }
            className="flex items-center gap-4 rounded-lg px-3 py-3 transition-colors hover:bg-white/5"
          >
            <button
              type="button"
              aria-label={`Play ${item.track?.title ?? "track"}`}
              disabled={!item.available || !item.track}
              onClick={() => {
                if (item.track)
                  void usePlayerStore.getState().playTrack(
                    item.track,
                    page?.items
                      .filter((item) => item.available && item.track)
                      .map((item) => item.track!),
                    "Local music",
                    "/downloads"
                  )
              }}
              className="group relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-white/5 disabled:opacity-40"
            >
              <ArtworkImage
                src={item.track?.thumbUrl ?? item.track?.albumThumbUrl}
                alt=""
                className="h-full w-full object-cover"
              />
              <span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <IconPlayerPlay size={22} />
              </span>
            </button>
            <div
              className={`min-w-0 flex-1 ${!item.available && ["unavailable", "error"].includes(item.status) ? "opacity-50" : ""}`}
            >
              <p className="truncate font-medium text-[var(--text-primary)]">
                {item.track?.title ?? `Track ${item.trackId}`}
              </p>
              <p className="mt-0.5 truncate text-xs text-[var(--text-secondary)]">
                {item.track
                  ? `${item.track.artistName} · ${item.track.albumName}`
                  : "Waiting for Plex metadata"}
              </p>
            </div>
            <div className="max-w-[40%] text-right">
              <p className="text-xs text-[var(--text-secondary)]">
                {status(item)}
              </p>
              {item.error && (
                <p className="mt-1 text-xs text-red-300">{item.error}</p>
              )}
            </div>
            {!cached && (
              <div className="flex shrink-0 gap-1">
                {["error", "unavailable"].includes(item.status) &&
                  !provider?.isOffline && (
                    <button
                      type="button"
                      disabled={pending !== null}
                      aria-label={`Retry download of ${item.track?.title ?? item.trackId}`}
                      onClick={() => void action(item, "retry")}
                      className="rounded-full border border-[var(--border)] bg-app-surface p-2 text-[var(--text-primary)] transition-colors hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
                    >
                      <IconRefresh size={18} />
                    </button>
                  )}
                <button
                  type="button"
                  disabled={pending !== null}
                  aria-label={`${item.available ? "Remove download of" : "Cancel download of"} ${item.track?.title ?? item.trackId}`}
                  onClick={() => void action(item, "remove")}
                  className="rounded-full border border-[var(--border)] bg-app-surface p-2 text-[var(--text-primary)] transition-colors hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
                >
                  <IconTrash size={18} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {page && page.total > PAGE_SIZE && (
        <div className="mt-6 flex items-center justify-center gap-5">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => {
              setPage(null)
              setOffset((value) => Math.max(0, value - PAGE_SIZE))
            }}
            className="rounded-full border border-[var(--border)] bg-app-surface px-4 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-[var(--text-secondary)]">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, page.total)} of{" "}
            {page.total}
          </span>
          <button
            type="button"
            disabled={offset + PAGE_SIZE >= page.total}
            onClick={() => {
              setPage(null)
              setOffset((value) => value + PAGE_SIZE)
            }}
            className="rounded-full border border-[var(--border)] bg-app-surface px-4 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </section>
  )
}
