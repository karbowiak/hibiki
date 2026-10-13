import { useEffect, useId, useState } from "react"
import { useSoulSyncStore } from "../../metadata/soulsync/store"
export function SoulSyncSettings() {
  const { status, loading, error, load, configure } = useSoulSyncStore()
  const [baseUrl, setBaseUrl] = useState(""),
    [key, setKey] = useState(""),
    [enabled, setEnabled] = useState(false),
    [saved, setSaved] = useState(false)
  const id = useId()
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (status) {
      setBaseUrl(status.baseUrl)
      setEnabled(status.enabled)
      setKey("")
    }
  }, [status?.revision])
  return (
    <section
      className="rounded-xl border border-[var(--border)] bg-app-surface p-5"
      aria-labelledby={`${id}-title`}
    >
      <h3 id={`${id}-title`} className="font-semibold">
        SoulSync{" "}
        <span className="text-xs text-[var(--text-muted)]">Optional</span>
      </h3>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Enrich artist, album and track metadata from your own SoulSync library,
        including descriptions and genres where available. Lookups are
        read-only and do not request downloads or library changes.
      </p>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={async (event) => {
          event.preventDefault()
          setSaved(false)
          if (await configure({ baseUrl, apiKey: key, enabled })) {
            setKey("")
            setSaved(true)
          }
        }}
      >
        <label className="text-sm" htmlFor={`${id}-url`}>
          Server URL
        </label>
        <input
          id={`${id}-url`}
          type="url"
          maxLength={2048}
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://soulsync.example.com"
          autoComplete="url"
          className="rounded-lg border border-[var(--border)] bg-app-bg px-3 py-2 text-sm"
          disabled={loading}
        />
        <label className="text-sm" htmlFor={`${id}-key`}>
          API key{" "}
          {(status?.hasApiKey || status?.configured) && (
            <span className="text-[var(--text-muted)]">
              (saved natively; leave blank only for the same server)
            </span>
          )}
        </label>
        <input
          id={`${id}-key`}
          type="password"
          maxLength={4096}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          className="rounded-lg border border-[var(--border)] bg-app-bg px-3 py-2 text-sm"
          disabled={loading}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={loading}
          />
          Enable SoulSync metadata
        </label>
        <p className="text-xs text-[var(--text-muted)]">
          Generate a key in SoulSync Settings → SoulSync API. Saving does not
          contact the service. Enter an API key when changing the server URL or
          path; saved keys stay with their original server. Choose SoulSync for
          an artist, album or track field in Edit to request metadata.
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="text-sm text-[var(--text-secondary)]">
            SoulSync settings saved.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={loading || !status}
            className="media-primary disabled:opacity-50"
          >
            {loading ? "Saving…" : "Save connection"}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setSaved(false)
              void load()
            }}
            className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
          >
            Reload settings
          </button>
          <button
            type="button"
            disabled={loading || !(status?.hasApiKey || status?.configured)}
            onClick={async () => {
              setSaved(false)
              if (await configure({ baseUrl, enabled: false, clear: true })) {
                setKey("")
                setSaved(true)
              }
            }}
            className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-50"
          >
            Clear credentials
          </button>
        </div>
      </form>
    </section>
  )
}
