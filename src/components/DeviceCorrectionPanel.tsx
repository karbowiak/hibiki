import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  editCorrection,
  parseCorrection,
  type SavedCorrection,
} from "../audio/deviceCorrection"
import { useEqStore } from "../stores/eqStore"
import { outputEqMatches } from "../stores/outputEqState"

interface Model {
  id: string
  name: string
  measurement: string
  rig: string
  target: string | null
}
interface Catalogue {
  items: Model[]
  total: number
  catalogueSize: number
  revision: string
  stale: boolean
}
interface Download {
  name: string
  text: string
  url: string
  revision: string
  measurement: string
  rig: string
  target: string | null
  license: string
}
const button =
  "min-h-8 rounded bg-(--bg-surface) px-2 py-1 text-xs text-(--text-primary) transition-colors hover:bg-(--bg-surface-hover) disabled:cursor-default disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
const field =
  "w-full rounded border border-(--border) bg-(--bg-surface) px-2 py-1.5 text-xs text-(--text-primary) placeholder:text-(--text-muted) focus:outline-2 focus:outline-accent"
const customSource: SavedCorrection["source"] = {
  kind: "custom",
  url: null,
  revision: null,
  measurement: null,
  rig: null,
  target: null,
  license: null,
}

export function DeviceCorrectionPanel() {
  const eq = useEqStore(),
    output = eq.currentOutput
  const [browse, setBrowse] = useState(false),
    [query, setQuery] = useState("")
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null),
    [searching, setSearching] = useState(false)
  const [draft, setDraft] = useState<SavedCorrection | null>(null),
    [label, setLabel] = useState(""),
    [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null),
    [downloading, setDownloading] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const searchRevision = useRef(0),
    downloadRevision = useRef(0)
  const selected = eq.selectedCorrectionId
    ? eq.corrections[eq.selectedCorrectionId]
    : null
  const bound = output ? eq.outputProfiles[output.id] : null
  const savedToOutput = outputEqMatches(eq, bound)
  const available = !!output?.available
  const active =
    eq.correctionPreview ?? (eq.correctionEnabled ? selected : null)
  const otherOutputs = Object.entries(eq.outputProfiles).filter(
    ([id]) => id !== output?.id
  )

  useEffect(() => {
    if (!browse) return
    let disposed = false,
      stop: (() => void) | undefined
    void listen("autoeq-catalogue-updated", () =>
      setRefresh((value) => value + 1)
    )
      .then((unlisten) => {
        if (disposed) unlisten()
        else stop = unlisten
      })
      .catch(() => {})
    return () => {
      disposed = true
      stop?.()
    }
  }, [browse])
  useEffect(() => {
    const revision = ++searchRevision.current
    setSearching(false)
    setCatalogue(null)
    if (!browse || query.trim().length < 2) return
    setSearching(true)
    const timer = window.setTimeout(() => {
      void invoke<Catalogue>("autoeq_search", { query: query.trim() })
        .then((result) => {
          if (revision === searchRevision.current) {
            setCatalogue(result)
            setSearching(false)
          }
        })
        .catch((reason) => {
          if (revision === searchRevision.current) {
            setError(String(reason))
            setSearching(false)
          }
        })
    }, 250)
    return () => {
      window.clearTimeout(timer)
      ++searchRevision.current
    }
  }, [browse, query, refresh])
  useEffect(() => {
    const key = output?.key
    ++downloadRevision.current
    setDownloading(null)
    setBrowse(false)
    setDraft(null)
    setError(null)
    return () => {
      ++downloadRevision.current
      if (key) useEqStore.getState().cancelCorrectionPreview(key)
    }
  }, [output?.key])

  if (!output) return null
  const openDraft = (profile: SavedCorrection) => {
    setDraft(profile)
    setLabel(profile.label)
    setText(profile.editedText ?? profile.originalText)
    setError(null)
  }
  const cancel = () => {
    eq.cancelCorrectionPreview(output.key)
    setBrowse(false)
    setDraft(null)
    setError(null)
    ++downloadRevision.current
    setDownloading(null)
  }
  const checkedDraft = () => {
    if (!label.trim()) throw Error("Give this correction a name.")
    return {
      ...editCorrection(draft!, text),
      label: label.trim().slice(0, 256),
    }
  }
  const download = async (model: Model) => {
    const revision = ++downloadRevision.current,
      key = output.key
    setDownloading(model.id)
    setError(null)
    try {
      const result = await invoke<Download>("autoeq_download", {
        modelId: model.id,
        sourceRevision: catalogue!.revision,
      })
      if (
        revision !== downloadRevision.current ||
        useEqStore.getState().currentOutput?.key !== key
      )
        return
      parseCorrection(result.text)
      openDraft({
        id: crypto.randomUUID(),
        label: result.name,
        originalText: result.text,
        createdAt: Date.now(),
        source: {
          kind: "autoeq",
          url: result.url,
          revision: result.revision,
          measurement: result.measurement,
          rig: result.rig,
          target: result.target,
          license: result.license,
        },
      })
    } catch (reason) {
      if (revision === downloadRevision.current) setError(String(reason))
    } finally {
      if (revision === downloadRevision.current) setDownloading(null)
    }
  }
  const custom = (content = "", name = "Custom correction") => {
    openDraft({
      id: crypto.randomUUID(),
      label: name,
      originalText: content,
      createdAt: Date.now(),
      source: customSource,
    })
  }

  return (
    <section
      aria-label="Device correction"
      className="px-4 py-4 text-xs"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-(--text-primary)">
          Device correction
        </h3>
        <span role="status" className="text-(--text-muted)">
          {!available
            ? "Output unavailable"
            : eq.applying
              ? "Applying…"
              : eq.eqError
                ? "Not applied"
                : eq.appliedOutputKey === output.key
                  ? active
                    ? "Applied"
                    : "Bypassed"
                  : "Ready"}
        </span>
      </div>
      <label className="mt-3 block text-(--text-muted)">
        Correction profile
        <select
          aria-label="Correction profile"
          className={`${field} mt-1`}
          value={eq.selectedCorrectionId ?? ""}
          disabled={!available}
          onChange={(event) => {
            try {
              eq.chooseCorrection(event.target.value || null)
              setError(null)
            } catch (reason) {
              setError(String(reason))
            }
          }}
        >
          <option value="">None</option>
          {Object.values(eq.corrections).map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          className={button}
          disabled={!available}
          onClick={() => {
            setBrowse(true)
            setError(null)
          }}
        >
          Find or import
        </button>
        {selected && (
          <button
            className={button}
            disabled={!available}
            onClick={() => {
              setBrowse(true)
              openDraft(selected)
            }}
          >
            Edit filters
          </button>
        )}
        <label className="ml-auto flex min-h-8 items-center gap-1.5 text-(--text-muted)">
          <input
            type="checkbox"
            className="accent-accent"
            checked={eq.correctionEnabled}
            disabled={!available || !selected}
            onChange={(event) => eq.setCorrectionEnabled(event.target.checked)}
          />{" "}
          Enabled
        </label>
      </div>
      {active &&
        eq.appliedEq &&
        eq.appliedOutputKey === output.key &&
        !eq.applying &&
        !eq.eqError && (
          <p className="mt-2 text-(--text-muted)">
            {eq.correctionPreview ? "Preview · " : ""}
            {active.label} · Preamp {eq.appliedEq.correctionPreampDb.toFixed(1)}{" "}
            dB
            {eq.appliedEq.safetyDb < -0.01
              ? ` · Additional headroom ${eq.appliedEq.safetyDb.toFixed(1)} dB`
              : ""}
          </p>
        )}
      <p className="mt-2 leading-relaxed text-(--text-muted)">
        For headphones sharing a DAC, choose the profile when you change headphones.
      </p>
      <p role="status" className="mt-4 text-(--text-secondary)">
        {savedToOutput ? "Saved for this output" : bound ? "Output settings have changed" : "Not saved to this output"}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className={button}
          disabled={!available || !!eq.correctionPreview || savedToOutput}
          onClick={() => eq.saveOutputProfile()}
        >
          Save to output
        </button>
        {bound && (
          <>
            <button
              className={button}
              disabled={!available}
              onClick={() => eq.recallOutputProfile()}
            >
              Recall saved
            </button>
            <button
              className={button}
              onClick={() => eq.removeOutputProfile(output.id)}
            >
              Forget output
            </button>
          </>
        )}
      </div>
      <label className="mt-2 flex min-h-8 items-center gap-2 text-(--text-muted)">
        <input
          type="checkbox"
          className="accent-accent"
          checked={bound?.automatic ?? false}
          disabled={!available || !output.stable}
          onChange={(event) => eq.setAutomaticRecall(event.target.checked)}
        />{" "}
        Recall automatically on this output
      </label>
      {!output.stable && (
        <p className="leading-relaxed text-(--text-muted)">
          This system route has no stable device identity. Use Recall saved
          after checking the connected output.
        </p>
      )}
      {(otherOutputs.length > 0 ||
        Object.keys(eq.deviceProfiles).length > 0) && (
        <details className="mt-2 text-(--text-muted)">
          <summary className="min-h-8 cursor-pointer py-1.5">
            Other saved settings
          </summary>
          {otherOutputs.map(([id, profile]) => (
            <div
              key={id}
              className="flex items-center justify-between gap-2 py-1"
            >
              <span className="min-w-0 truncate">
                {profile.name} · another output
              </span>
              <button
                className={button}
                onClick={() => eq.removeOutputProfile(id)}
              >
                Forget
              </button>
            </div>
          ))}
          {Object.keys(eq.deviceProfiles).map((name) => (
            <div
              key={name}
              className="flex items-center justify-between gap-2 py-1"
            >
              <span className="min-w-0 truncate">
                {name} · older tone settings
              </span>
              <button
                className={button}
                disabled={!available}
                onClick={() => eq.loadProfileForDevice(name)}
              >
                Load tone
              </button>
            </div>
          ))}
        </details>
      )}
      {browse && (
        <div className="mt-3 border-t border-(--border) pt-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-semibold text-(--text-primary)">
              {draft ? "Correction filters" : "Find a correction"}
            </h4>
            <button className={button} onClick={cancel}>
              Cancel
            </button>
          </div>
          {!draft ? (
            <>
              <label className="mt-2 block text-(--text-muted)">
                AutoEq model or manufacturer
                <input
                  className={`${field} mt-1`}
                  maxLength={256}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setError(null)
                  }}
                  placeholder="Search exact model, pads or ANC mode"
                />
              </label>
              <p role="status" className="mt-2 text-(--text-muted)">
                {searching
                  ? "Searching AutoEq…"
                  : catalogue
                    ? `${catalogue.total.toLocaleString()} matches${catalogue.total > 50 ? " · Showing 50; refine your search" : ""}${catalogue.stale ? " · Saved catalogue, refreshing" : ""}`
                    : "Search online, or import a custom speaker or headphone profile below."}
              </p>
              {catalogue && (
                <ul className="mt-2 max-h-52 divide-y divide-(--border) overflow-y-auto">
                  {catalogue.items.map((model) => (
                    <li key={model.id}>
                      <button
                        className="focus-visible:outline-accent w-full rounded px-1 py-2 text-left text-(--text-primary) hover:bg-(--bg-surface-hover) focus-visible:outline-2 disabled:opacity-40"
                        disabled={!!downloading || !available}
                        onClick={() => void download(model)}
                      >
                        <span className="block">
                          {model.name}
                          {downloading === model.id ? " · Downloading…" : ""}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-(--text-muted)">
                          {model.measurement} · {model.rig}
                          {model.target ? ` · ${model.target}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button className={button} onClick={() => custom()}>
                  Paste custom filters
                </button>
                <label
                  className={`${button} focus-within:outline-accent inline-flex cursor-pointer items-center focus-within:outline-2`}
                >
                  Import text file
                  <input
                    type="file"
                    className="sr-only"
                    accept=".txt,text/plain"
                    aria-label="Import correction text file"
                    onChange={(event) => {
                      const file = event.target.files?.[0],
                        key = output.key
                      event.target.value = ""
                      if (!file) return
                      if (file.size > 65536) {
                        setError("Choose a text file up to 64 KB.")
                        return
                      }
                      const revision = ++downloadRevision.current
                      void file
                        .text()
                        .then((content) => {
                          if (
                            revision !== downloadRevision.current ||
                            useEqStore.getState().currentOutput?.key !== key
                          )
                            return
                          parseCorrection(content)
                          custom(content, file.name.replace(/\.txt$/i, ""))
                        })
                        .catch((reason) => {
                          if (revision === downloadRevision.current)
                            setError(String(reason))
                        })
                    }}
                  />
                </label>
              </div>
            </>
          ) : (
            <>
              <label className="mt-2 block text-(--text-muted)">
                Profile name
                <input
                  className={`${field} mt-1`}
                  maxLength={256}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              {draft.source.measurement && (
                <p className="mt-2 text-(--text-muted)">
                  {draft.source.measurement} · {draft.source.rig} ·{" "}
                  {draft.source.target ?? "Target not specified"}
                </p>
              )}
              <label className="mt-2 block text-(--text-muted)">
                Parametric filters
                <textarea
                  className={`${field} mt-1 min-h-44 resize-y font-mono leading-relaxed`}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  maxLength={65536}
                  placeholder={
                    "Preamp: -6 dB\nFilter 1: ON PK Fc 1000 Hz Gain 4 dB Q 1.4"
                  }
                  spellCheck={false}
                />
              </label>
              <p className="mt-1 text-(--text-muted)">
                Preamp and up to 20 peak (PK) or shelf (LSC, HSC) filters with
                frequency, gain and Q. Unsupported commands are rejected.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className={button}
                  disabled={!available}
                  aria-pressed={!!eq.correctionPreview}
                  onClick={() => {
                    try {
                      eq.previewCorrection(checkedDraft(), output.key)
                      setError(null)
                    } catch (reason) {
                      setError(String(reason))
                    }
                  }}
                >
                  Preview
                </button>
                {eq.correctionPreview && <button className={button} onClick={() => eq.cancelCorrectionPreview(output.key)}>Stop preview</button>}
                <button
                  className={`${button} bg-(--accent-tint-subtle)`}
                  disabled={!available}
                  onClick={() => {
                    try {
                      const profile = checkedDraft()
                      // A manually entered profile's first accepted text is its original.
                      if (
                        !profile.originalText &&
                        profile.source.kind === "custom"
                      ) {
                        profile.originalText = text
                        profile.editedText = undefined
                      }
                      eq.saveCorrection(profile)
                      setDraft(null)
                      setBrowse(false)
                      setError(null)
                    } catch (reason) {
                      setError(String(reason))
                    }
                  }}
                >
                  Apply
                </button>
                {draft.originalText && (
                  <button
                    className={button}
                    onClick={() => setText(draft.originalText)}
                  >
                    Reset local edits
                  </button>
                )}
                {eq.corrections[draft.id] && (
                  <button
                    className={button}
                    onClick={() => {
                      eq.cancelCorrectionPreview(output.key)
                      eq.removeCorrection(draft.id)
                      setDraft(null)
                      setBrowse(false)
                    }}
                  >
                    Remove correction
                  </button>
                )}
              </div>
              {draft.source.kind === "autoeq" && (
                <details className="mt-3 text-(--text-muted)">
                  <summary className="cursor-pointer">
                    Source and licence
                  </summary>
                  <a
                    href={draft.source.url ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block break-words underline underline-offset-2"
                    onClick={(event) => {
                      event.preventDefault()
                      if (draft.source.url)
                        void openUrl(draft.source.url).catch(() =>
                          setError(
                            "Couldn’t open the profile source in your browser."
                          )
                        )
                    }}
                  >
                    AutoEq · {draft.source.revision?.slice(0, 12)}
                  </a>
                  <pre className="mt-2 font-sans text-[11px] leading-relaxed whitespace-pre-wrap">
                    {draft.source.license}
                  </pre>
                </details>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 leading-relaxed text-(--text-primary)">
          {error}
        </p>
      )}
    </section>
  )
}
