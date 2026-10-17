import { useEffect, useRef, useState } from "react"
import { useFavoritesStore } from "../../stores/favoritesStore"
import { useProviderStore } from "../../stores/providerStore"
import { FavoritesSyncDialog } from "../FavoritesSyncDialog"

export function LikedSyncControls() {
  const provider = useProviderStore((state) => state.provider)
  const { collection, loaded, running, resetting } = useFavoritesStore()
  const [manage, setManage] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const resetButton = useRef<HTMLButtonElement>(null)
  const manageButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  const busy = useRef(false)
  const enabled = Object.entries(collection.settings).some(
    ([key, value]) => key !== "ratingThreshold" && value === true
  )
  const pending = Object.values(collection.bindings).some(
    (binding) => binding?.pending || binding?.creation
  )
  useEffect(() => {
    let current = true
    setConfirm(false)
    setMessage(null)
    setError(null)
    void useFavoritesStore
      .getState()
      .load(provider)
      .catch(() => {
        if (current)
          setError(
            "Could not load liked sync. Reconnect your library and try again."
          )
      })
    return () => {
      current = false
    }
  }, [provider, provider?.playbackSession])
  useEffect(() => {
    if (confirm) cancelButton.current?.focus()
    else if (wasConfirming.current)
      (resetButton.current?.disabled
        ? manageButton.current
        : resetButton.current
      )?.focus()
    wasConfirming.current = confirm
  }, [confirm])
  const disabled =
    !provider?.favorites || !loaded || running || resetting || pending
  async function reset() {
    if (disabled || busy.current) return
    busy.current = true
    setError(null)
    setMessage(null)
    const session = provider?.playbackSession
    const current = () =>
      useProviderStore.getState().provider === provider &&
      provider?.playbackSession === session
    try {
      await useFavoritesStore.getState().resetSync()
      if (!current()) return
      setConfirm(false)
      setMessage(
        !enabled
          ? "Liked sync reset. Choose a service in Manage sync to import likes."
          : provider?.isOffline
            ? "Liked sync reset. Likes will be imported when you reconnect."
            : "Liked sync reset."
      )
      if (enabled && !provider?.isOffline)
        void useFavoritesStore
          .getState()
          .sync()
          .catch(() => {
            if (current())
              setError(
                "Liked sync was reset, but the import could not start. Open Manage sync to retry."
              )
          })
    } catch (failure) {
      if (current())
        setError(
          failure instanceof Error
            ? failure.message
            : typeof failure === "string"
              ? failure
              : "Could not reset liked sync. Try again."
        )
    } finally {
      busy.current = false
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-(--text-secondary)">
        Manage likes shared with Plex, Last.fm and ListenBrainz, or rebuild
        imported likes and their library matches.
      </p>
      {confirm ? (
        <div
          className="space-y-3 border-t border-(--border) pt-4"
          aria-label="Reset liked sync"
        >
          <h3 className="text-sm font-semibold text-(--text-primary)">
            Reset liked sync?
          </h3>
          <p className="max-w-prose text-sm text-(--text-secondary)">
            Imported likes and their matches will be rebuilt from your enabled
            services. Your local hearts and unlikes, star ratings, and sync
            connections stay saved.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              ref={cancelButton}
              type="button"
              className="media-secondary"
              disabled={resetting}
              onClick={() => {
                setConfirm(false)
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="media-primary"
              disabled={disabled}
              onClick={() => void reset()}
            >
              {resetting ? "Resetting…" : "Reset and reimport"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            ref={manageButton}
            type="button"
            className="media-secondary"
            disabled={!provider?.favorites || !loaded || resetting}
            onClick={() => setManage(true)}
          >
            Manage sync
          </button>
          <button
            ref={resetButton}
            type="button"
            className="media-secondary"
            disabled={disabled}
            onClick={() => {
              setConfirm(true)
              setMessage(null)
              setError(null)
            }}
          >
            Reset liked sync…
          </button>
        </div>
      )}
      {!provider?.favorites && (
        <p className="text-sm text-(--text-muted)">
          Connect a music library to manage liked sync.
        </p>
      )}
      {running && (
        <p role="status" className="text-sm text-(--text-secondary)">
          Syncing likes. You can reset once this finishes.
        </p>
      )}
      {pending && (
        <p className="text-sm text-(--text-secondary)">
          Review pending sync changes in Manage sync before resetting.
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-(--text-secondary)">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      {manage && <FavoritesSyncDialog onClose={() => setManage(false)} />}
    </div>
  )
}
