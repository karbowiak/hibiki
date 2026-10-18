import { useEffect, useRef, useState } from "react"
import { useProviderOwner } from "../hooks/useProviderOwner"
import { useProviderStore } from "../stores/providerStore"
import type { MatchingAction, MatchingStatus } from "../matching/types"
import { withTimeout } from "../lib/withTimeout"

export function MatchingIndexControls() {
  const { provider, scope, session } = useProviderOwner()
  const [info, setInfo] = useState<MatchingStatus | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  const controlRequest = useRef<number | null>(null)
  const owns = () =>
    provider === useProviderStore.getState().provider &&
    provider?.cacheScope === scope &&
    provider?.playbackSession === session
  useEffect(() => {
    let active = true,
      pending = false
    setInfo(null)
    setError("")
    setBusy(false)
    controlRequest.current = null
    const read = async () => {
      if (pending || controlRequest.current !== null || !provider?.matchingIndexStatus) return
      pending = true
      const revision = ++request.current
      try {
        const value = await withTimeout(provider.matchingIndexStatus(), 5000, "Matching status timed out.")
        if (active && owns() && revision === request.current) {
          setInfo(value)
          setError("")
        }
      } catch {
        if (active && owns() && revision === request.current)
          setError("Could not read the matching index. Reconnect or try again.")
      } finally {
        pending = false
      }
    }
    void read()
    const timer = setInterval(() => {
      void read()
    }, 5000)
    return () => {
      active = false
      clearInterval(timer)
      ++request.current
    }
  }, [provider, scope, session])
  async function control(action: MatchingAction) {
    if (!provider?.matchingIndexControl || controlRequest.current !== null) return
    const revision = ++request.current
    controlRequest.current = revision
    setBusy(true)
    setError("")
    try {
      const value = await withTimeout(provider.matchingIndexControl(action), 10_000, "Matching control timed out.")
      if (owns() && revision === request.current) setInfo(value)
    } catch {
      if (owns() && revision === request.current)
        setError(
          "The index could not be updated. Your music and saved playlists are retained; try again."
        )
    } finally {
      if (controlRequest.current === revision) {
        controlRequest.current = null
        if (owns()) setBusy(false)
      }
    }
  }
  return (
    <div className="space-y-4 text-sm text-(--text-primary)">
      <p className="text-(--text-secondary)">
        {!provider?.matchingIndexStatus
          ? "Connect a Plex library to build its matching index."
          : !info
            ? "Reading matching progress…"
            : info.paused
              ? "Paused. Existing matching evidence remains available."
              : "Artists, releases and songs are indexed in the background. Playback preparation takes priority."}
      </p>
      {info && (
        <ul className="divide-y divide-(--border)">
          {(["artist", "album", "track"] as const).map((kind) => {
            const task = info.tasks.find((task) => task.kind === kind)
            const refresh = info.health?.refreshes.find((item) => item.kind === kind)
            const label =
              kind === "artist"
                ? "Artists"
                : kind === "album"
                  ? "Releases"
                  : "Songs"
            return (
              <li
                key={kind}
                className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2"
              >
                <span>{label}</span>
                <span className="text-right text-(--text-secondary)">
                  {!task
                    ? "Waiting"
                    : task.phase === "complete"
                      ? `${task.count.toLocaleString()} · Covered`
                      : `${task.count.toLocaleString()}${task.total !== null ? ` / ${task.total.toLocaleString()}` : ""} · ${task.phase === "scan" ? "Indexing" : task.phase === "verify" ? "Verifying" : "Reconciling"}`}
                  {task?.completed
                    ? ` · ${new Date(task.completed).toLocaleString()}`
                    : ""}
                </span>
                {task?.error && (
                  <span className="w-full text-xs text-(--text-secondary)">
                    {task.error} · Retrying automatically
                  </span>
                )}
                {refresh && (
                  <span className="w-full text-xs text-(--text-secondary)">
                    {refresh.active ? "Checking recent changes…" : refresh.lastChecked ? `Metadata checked ${new Date(refresh.lastChecked).toLocaleString()}` : "Recent changes have not been checked yet."}
                    {refresh.error ? ` · ${refresh.error} · Retrying automatically` : ""}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {info?.health && (
        <p className="text-xs text-(--text-secondary)">
          {info.health.pending ? `${info.health.pending.toLocaleString()} changes waiting. ` : ""}
          {info.health.reconciliationPending ? "Library reconciliation requested. " : ""}
          {info.health.error ?? (info.health.lastCheck ? `Library checked ${new Date(info.health.lastCheck).toLocaleString()}. ` : "")}
          {!Object.keys(info.health.filters).length && "Periodic inventory checks cover changes this server cannot filter."}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(
          [
            info?.paused ? "resume" : "pause",
            "rebuild",
            "clear",
          ] as MatchingAction[]
        ).map((action) => (
          <button
            key={action}
            type="button"
            disabled={busy || !provider?.matchingIndexControl}
            onClick={() => void control(action)}
            className="hover:bg-app-surface-hover focus-visible:outline-accent rounded-lg border border-(--border) px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
          >
            {action === "pause"
              ? "Pause indexing"
              : action === "resume"
                ? "Resume indexing"
                : action === "rebuild"
                  ? "Rebuild index"
                  : "Clear index"}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-(--text-secondary)">
          {error}
        </p>
      )}
    </div>
  )
}
