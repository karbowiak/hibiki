import { useEffect, useRef, useState } from "react"
import { useLinkedPlaylistStore } from "../../stores/linkedPlaylistStore"
import { useProviderStore } from "../../stores/providerStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
import { providerPlaylistAccount } from "../../playlistSync/provider"
import { samePlaylistIdentity } from "../../playlistSync/types"
import type { MusicPlaylist } from "../../types/music"
import type { SyncCreationIntent } from "../../playlistSync/creation"
import { useCopyOwner } from "./useCopyOwner"
const button =
  "rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
/** Recovery performs reads and local retention only; it never repeats playlist creation. */
export function PlaylistCreationRecovery({
  playlists,
  onRecovered,
}: {
  playlists: MusicPlaylist[]
  onRecovered?(playlistId: string): void
}) {
  const provider = useProviderStore((s) => s.provider)
  const username = useListenBrainzStore((s) => s.username)
  const authenticated = useListenBrainzStore((s) => s.isAuthenticated)
  const intents = useLinkedPlaylistStore((s) => s.creationIntents)
  const unretained = useLinkedPlaylistStore((s) => s.unretainedCreations)
  const activeCreations = useLinkedPlaylistStore((s) => s.activeCreationIds)
  const capture = useCopyOwner(provider, "sync-creation-recovery")
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const current = capture()
    void useLinkedPlaylistStore
      .getState()
      .loadCreationIntents()
      .catch(() => {
        if (current())
          setError(
            "Creation recovery could not be read. Do not repeat a create until local storage is available."
          )
      })
  }, [capture])
  const rows =
    provider?.cacheScope && authenticated
      ? intents.filter(
          (intent) =>
            !activeCreations[intent.id] &&
            samePlaylistIdentity(
              intent.target,
              providerPlaylistAccount(provider)
            ) &&
            intent.sourceSnapshot.account.user === username &&
            ((intent.state !== "linked" && intent.state !== "cancelled") ||
              unretained[intent.id])
        )
      : []
  if (!rows.length && !error) return null
  return (
    <section
      aria-label="Playlist creation recovery"
      className="mb-5 space-y-3 rounded-xl border border-[var(--border)] bg-app-surface p-4"
    >
      <h3 className="font-semibold">Creation needs inspection</h3>
      <p className="text-sm text-[var(--text-secondary)]">
        A previous create may have reached Plex. Recover its original
        destination before requesting another playlist.
      </p>
      {error && <p role="alert">{error}</p>}
      {rows.map((intent) => (
        <RecoveryRow
          key={intent.id}
          intent={intent}
          playlists={playlists}
          current={capture}
          onRecovered={onRecovered}
        />
      ))}
    </section>
  )
}
function RecoveryRow({
  intent,
  playlists,
  current,
  onRecovered,
}: {
  intent: SyncCreationIntent
  playlists: MusicPlaylist[]
  current: () => () => boolean
  onRecovered?(id: string): void
}) {
  const [destination, setDestination] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  async function recover() {
    if (
      pending.current ||
      (!intent.destinationId && (!destination || !acknowledged))
    )
      return
    pending.current = true
    const owns = current()
    setBusy(true)
    setError(null)
    try {
      const result = await useLinkedPlaylistStore
        .getState()
        .recoverCreation(
          intent.id,
          destination || undefined,
          owns,
          acknowledged
        )
      if (owns()) onRecovered?.(result.link.libraryPlaylistId)
    } catch {
      if (owns())
        setError(
          "Could not recover this creation. Inspect the original empty destination and local storage; no new playlist was requested."
        )
    } finally {
      pending.current = false
      if (owns()) setBusy(false)
    }
  }
  return (
    <article className="rounded-lg border border-[var(--border)] p-3">
      <h4 className="break-words font-medium">{intent.title}</h4>
      {intent.destinationId ? (
        <p className="mt-2 text-sm">
          The original destination ID is retained. Recovery checks it without
          creating another playlist.
        </p>
      ) : (
        <>
          <label className="mt-3 block text-sm">
            Inspect and select the original destination
            <select
              className={`${button} mt-1 w-full bg-app-surface`}
              value={destination}
              disabled={busy}
              onChange={(event) => {
                setDestination(event.target.value)
                setAcknowledged(false)
              }}
            >
              <option value="">Choose an inspected playlist</option>
              {playlists
                .filter((item) => !item.smart)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I inspected this playlist and confirm it is the empty destination
            from this creation.
          </label>
        </>
      )}
      <button
        className={`${button} mt-3`}
        disabled={
          busy || (!intent.destinationId && (!destination || !acknowledged))
        }
        onClick={() => void recover()}
      >
        {busy ? "Checking recovery…" : "Recover without creating"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm">
          {error}
        </p>
      )}
    </article>
  )
}
