import { Checkbox } from "../shared/Checkbox"
import { Button } from "../shared/Button"
import { useEffect, useId, useState } from "react"
import { useTheAudioDbStore } from "../../metadata/theaudiodb/store"
export function TheAudioDbSettings({ embedded = false }: { embedded?: boolean } = {}) {
  const id = useId(),
    { status, loading, error, load, configure } = useTheAudioDbStore()
  const [key, setKey] = useState(""),
    [enabled, setEnabled] = useState(false)
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    setKey("")
    setEnabled(status?.enabled ?? false)
  }, [status?.revision])
  return (
    <section
      className={embedded ? "space-y-3" : "mt-6 rounded-xl border border-(--border) p-4"}
      aria-labelledby={embedded ? undefined : `${id}-title`}
    >
      {!embedded && <h3 id={`${id}-title`} className="font-semibold">
        TheAudioDB
      </h3>}
      <p className="mt-1 text-sm text-(--text-muted)">
        Artist biographies, album and track descriptions, genres and artwork
        from TheAudioDB. A premium V2 API key is required.
      </p>
      <form
        className="mt-4 flex flex-col gap-2"
        onSubmit={async (event) => {
          event.preventDefault()
          if (await configure({ apiKey: key, enabled })) setKey("")
        }}
      >
        <label htmlFor={`${id}-key`} className="text-sm">
          Premium API key
          {status?.hasApiKey && " · Saved privately; leave blank to keep it"}
        </label>
        <input
          id={`${id}-key`}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          maxLength={4096}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          disabled={loading}
          className="rounded-lg border border-(--border) bg-app-bg px-3 py-2"
        />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={enabled}
            disabled={loading}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable TheAudioDB
        </label>
        <p className="text-xs text-(--text-muted)">
          Requests use TheAudioDB’s official server. Saving does not contact it.{" "}
          <a
            href="https://www.theaudiodb.com/pricing"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Get a premium key
          </a>
          . Artwork is attributed to TheAudioDB; third-party rights and
          subscription terms still apply.
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary"
            disabled={loading || !status}
            className="rounded-lg px-3 py-2 text-sm text-(--artwork-ink,var(--accent-foreground,#111)) disabled:opacity-50"
          >
            Save settings
          </Button>
          <Button
            variant="secondary"
            type="button"
            disabled={loading}
            onClick={() => void load()}
            className="rounded-lg border border-(--border) px-3 py-2 text-sm"
          >
            Reload settings
          </Button>
          {status?.hasApiKey && (
            <Button
              variant="secondary"
              type="button"
              disabled={loading}
              onClick={async () => {
                if (await configure({ enabled: false, clear: true })) setKey("")
              }}
              className="rounded-lg border border-(--border) px-3 py-2 text-sm"
            >
              Clear saved key
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}
