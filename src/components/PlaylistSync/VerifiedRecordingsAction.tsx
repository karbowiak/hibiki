import { useEffect, useRef, useState } from "react"
import type { MusicProvider } from "../../providers/types"
import type { PlaylistPlan } from "../../playlistSync/types"
import { resolveSelectedPlaylistRecordings } from "../../playlistSync/recordingResolver"
/** Read-only, explicit selected-playlist proof. It never upgrades a suggestion. */
export function VerifiedRecordingsAction({
  provider,
  plan,
  current,
  disabled,
  onResolved,
  onRunning,
}: {
  provider: MusicProvider | null
  plan: PlaylistPlan
  current: () => () => boolean
  disabled: boolean
  onResolved(plan: PlaylistPlan): void
  onRunning?(running: boolean): void
}) {
  const [running, setRunning] = useState(false),
    [progress, setProgress] = useState({ completed: 0, total: 0 }),
    [message, setMessage] = useState<string | null>(null)
  const active = useRef(true),
    pending = useRef<AbortController | null>(null)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      pending.current?.abort()
      onRunning?.(false)
    }
  }, [onRunning])
  async function run() {
    if (disabled || pending.current || !provider?.resolvePlaylistRecording)
      return
    const controller = new AbortController(),
      owns = current()
    pending.current = controller
    setRunning(true)
    onRunning?.(true)
    setMessage(null)
    setProgress({
      completed: 0,
      total: new Set(plan.rows.map((row) => row.source.id)).size,
    })
    try {
      const result = await resolveSelectedPlaylistRecordings(
        provider,
        plan.rows.map((row) => row.source),
        {
          signal: controller.signal,
          current: () => (active.current && owns() ? provider : null),
          onProgress: (state) => {
            if (active.current && owns())
              setProgress({ completed: state.completed, total: state.total })
          },
        }
      )
      if (!active.current || !owns() || result.status === "retired") return
      let verified = 0
      const rows = plan.rows.map((row) => {
        const mbid = result.verifiedMbid(row.source)
        if (!mbid) return row
        verified++
        return {
          ...row,
          match: {
            status: "matched" as const,
            by: "mbid" as const,
            track: { ...row.source, recordingMbid: mbid },
          },
        }
      })
      onResolved({ ...plan, rows })
      setMessage(
        `${result.status === "cancelled" ? "Cancelled. " : ""}${verified} of ${plan.rows.length} occurrences have verified recording IDs. Unresolved songs still need review.`
      )
    } catch {
      if (active.current && owns())
        setMessage(
          "Verified recording lookup could not finish. Keep unresolved songs for manual review."
        )
    } finally {
      if (pending.current === controller) pending.current = null
      if (active.current) {
        setRunning(false)
        onRunning?.(false)
      }
    }
  }
  if (plan.direction !== "export" || !provider?.resolvePlaylistRecording)
    return null
  return (
    <section
      aria-label="Verified recording lookup"
      className="rounded-xl border border-(--border) bg-app-surface p-4"
    >
      <p className="text-sm text-(--text-secondary)">
        Look up recording IDs for this playlist. Only confirmed matches are
        accepted; songs with uncertain matches still need your choice.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="media-secondary"
          disabled={disabled || running}
          onClick={() => void run()}
        >
          Resolve verified recording IDs
        </button>
        {running && (
          <>
            <span role="status" className="text-sm">
              Checking {progress.completed} / {progress.total} tracks…
            </span>
            <button
              type="button"
              className="media-secondary"
              onClick={() => pending.current?.abort()}
            >
              Cancel lookup
            </button>
          </>
        )}
      </div>
      {message && (
        <p role="status" className="mt-3 text-sm text-(--text-secondary)">
          {message}
        </p>
      )}
    </section>
  )
}
