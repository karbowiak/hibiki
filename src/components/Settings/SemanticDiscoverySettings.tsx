import { useEffect } from "react"
import { useSemanticSettingsStore } from "../../semantic/store"
import {
  useSemanticDiscovery,
  refreshSemanticIndex,
} from "../../semantic/discovery"
export function SemanticDiscoverySettings() {
  const state = useSemanticSettingsStore()
  const index = useSemanticDiscovery()
  useEffect(() => {
    void state.checkInstalled()
  }, [])
  return (
    <section
      aria-labelledby="semantic-settings-title"
      className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 text-[var(--text-primary)]"
    >
      <h3 id="semantic-settings-title" className="font-semibold">
        Local semantic discovery
      </h3>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Find saved music by describing its mood or sound. A local text model
        compares descriptions, genres and moods; it does not listen to audio or
        send your library to a service. Results cover only saved and visited
        pages, not your entire Plex library.
      </p>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Optional verified download: about 48 MiB including the runtime.
        Inference stays on this device and works offline after installation.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {!state.installed && (
          <button
            type="button"
            disabled={state.installing}
            onClick={() => void state.download()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {state.installing
              ? `Downloading and verifying… ${Math.round(state.progress * 100)}%`
              : "Download local model"}
          </button>
        )}
        {state.installed && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={state.enabled}
                onChange={(event) =>
                  state.setEnabled(event.currentTarget.checked)
                }
                className="accent-accent"
              />
              Enable local semantic discovery
            </label>
            <button
              type="button"
              disabled={
                !state.enabled ||
                index.status === "loading" ||
                index.status === "indexing" ||
                !index.scope
              }
              onClick={() => void refreshSemanticIndex()}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-elevated)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              Index saved pages
            </button>
          </>
        )}
      </div>
      {index.scope && state.enabled && (
        <p role="status" className="mt-3 text-sm text-[var(--text-secondary)]">
          {index.status === "indexing"
            ? `Indexing saved pages… ${Math.round(index.progress * 100)}%`
            : index.status === "loading"
              ? "Loading the local model…"
              : `${index.indexed} saved music items indexed for this account and library.`}
        </p>
      )}
      {(state.error || index.error) && (
        <p role="alert" className="mt-3 text-sm text-[var(--text-primary)]">
          {state.error || index.error}
        </p>
      )}
    </section>
  )
}
