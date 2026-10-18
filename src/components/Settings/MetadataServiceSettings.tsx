import { Checkbox } from "../shared/Checkbox"
import { Button } from "../shared/Button"
import { useEffect, useId, useState } from "react"
import {
  useFanartServiceStore,
  useHeyaServiceStore,
} from "../../metadata/services/store"
import type { ConfiguredMetadataService } from "../../metadata/services/api"
export function MetadataServiceSettings({
  service,
  embedded = false,
}: {
  service: ConfiguredMetadataService
  embedded?: boolean
}) {
  const id = useId(),
    store = service === "fanart" ? useFanartServiceStore : useHeyaServiceStore
  const { status, loading, error, load, configure } = store()
  const [baseUrl, setBaseUrl] = useState(""),
    [key, setKey] = useState(""),
    [enabled, setEnabled] = useState(false)
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (!status) return
    setBaseUrl(status.baseUrl)
    setEnabled(status?.enabled ?? false)
    setKey("")
  }, [status?.revision])
  const name = service === "fanart" ? "Fanart.tv" : "HeyaMetadata"
  const input =
    "rounded-lg border border-(--border) bg-app-bg px-3 py-2 text-sm"
  return (
    <section
      className={embedded ? "space-y-3" : "mt-6 rounded-xl border border-(--border) p-4"}
      aria-labelledby={embedded ? undefined : `${id}-heading`}
    >
      {!embedded && <h3 id={`${id}-heading`} className="text-base font-semibold">
        {name}
      </h3>}
      <p className="mt-1 text-sm text-(--text-muted)">
        {service === "fanart"
          ? "Artist backgrounds, portraits, and album covers matched by MusicBrainz identity."
          : "Use metadata from your HeyaMetadata server, with its original source provenance."}
      </p>
      <form
        className="mt-4 flex flex-col gap-2"
        onSubmit={async (event) => {
          event.preventDefault()
          if (await configure({ baseUrl, apiKey: key, enabled })) setKey("")
        }}
      >
        {service === "heya" && (
          <>
            <label htmlFor={`${id}-url`} className="text-sm">
              Server URL
            </label>
            <input
              id={`${id}-url`}
              type="url"
              autoComplete="url"
              maxLength={2048}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://metadata.example.com"
              disabled={loading}
              className={input}
            />
          </>
        )}
        <label htmlFor={`${id}-key`} className="text-sm">
          {service === "fanart"
            ? "Project API key"
            : "API key (optional for public servers)"}
          {status?.hasApiKey && (
            <span className="text-(--text-muted)">
              {" "}
              · Saved natively; leave blank only for the same server
            </span>
          )}
        </label>
        <input
          id={`${id}-key`}
          type="password"
          autoComplete="new-password"
          maxLength={4096}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          disabled={loading}
          spellCheck={false}
          className={input}
        />
        <label className="mt-2 flex items-center gap-2 text-sm">
          <Checkbox
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={loading}
          />
          Enable {name} metadata
        </label>
        <p className="text-xs text-(--text-muted)">
          {service === "fanart" ? (
            <>
              Requests use Fanart.tv’s official server. Get a project key from{" "}
              <a
                className="underline"
                href="https://fanart.tv/get-an-api-key/"
                target="_blank"
                rel="noreferrer"
              >
                Fanart.tv
              </a>
              .
            </>
          ) : (
            "Automatic lookups read existing metadata and may refresh stale data on your HeyaMetadata server. Explicit discovery in Edit → Identity can create canonical metadata and start discovery jobs on that server. These operations do not change your Plex library. Artwork is loaded from verified image choices through the desktop cache."
          )}{" "}
          Saving stores credentials privately in the desktop app and does not
          contact the service.{" "}
          {service === "heya" &&
            "Enter a key again when changing the server URL or path."}
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="primary"
            type="submit"
            className="rounded-lg px-3 py-2 text-sm text-(--artwork-ink,var(--accent-foreground,#111)) disabled:opacity-50"
            disabled={loading || !status}
          >
            {loading ? "Saving…" : "Save settings"}
          </Button>
          <Button
            variant="secondary"
            type="button"
            className="rounded-lg border border-(--border) px-3 py-2 text-sm disabled:opacity-50"
            disabled={loading}
            onClick={() => void load()}
          >
            Reload settings
          </Button>
          {status?.hasApiKey && (
            <Button
              variant="secondary"
              type="button"
              className="rounded-lg border border-(--border) px-3 py-2 text-sm disabled:opacity-50"
              disabled={loading}
              onClick={async () => {
                if (await configure({ baseUrl, enabled: false, clear: true }))
                  setKey("")
              }}
            >
              Clear saved key
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}
