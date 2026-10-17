import { useEffect, useRef, useState } from "react"
import { useProviderStore } from "../../stores/providerStore"
import {
  advancedMetadataLabels,
  planAdvancedMetadata,
  type AdvancedMetadata,
  type AdvancedMetadataField,
  type AdvancedMetadataKey,
} from "../../lib/metadataAdvanced"
export interface AdvancedMetadataPanelProps {
  kind: "artist" | "album"
  itemId: string
  onSavingChange?: (saving: boolean) => void
  onSaved?: () => void
  disabled?: boolean
}
/** Current-library advanced fields; unknown server locks are honestly read-only. */
export function AdvancedMetadataPanel({
  kind,
  itemId,
  onSavingChange,
  onSaved,
  disabled = false,
}: AdvancedMetadataPanelProps) {
  const provider = useProviderStore((s) => s.provider)
  const [baseline, setBaseline] = useState<AdvancedMetadata | null>(null),
    [draft, setDraft] = useState<AdvancedMetadata["fields"]>({}),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null),
    [reload, setReload] = useState(0),
    [review, setReview] = useState<ReturnType<
      typeof planAdvancedMetadata
    > | null>(null)
  const generation = useRef(0),
    admission = useRef(false)
  useEffect(() => {
    const revision = ++generation.current,
      scope = provider?.cacheScope,
      session = provider?.playbackSession
    const current = () =>
      revision === generation.current &&
      useProviderStore.getState().provider === provider &&
      provider?.cacheScope === scope &&
      provider?.playbackSession === session
    setBaseline(null)
    setDraft({})
    setReview(null)
    setError(null)
    setLoading(true)
    setSaving(false)
    if (
      !provider?.getAdvancedMetadata ||
      !provider.editAdvancedMetadata ||
      provider.isOffline
    ) {
      setLoading(false)
      return
    }
    void provider
      .getAdvancedMetadata(kind, itemId)
      .then((result) => {
        if (!current()) return
        if (result.kind !== kind || String(result.itemId) !== itemId)
          throw Error("retired detail")
        setBaseline(result)
        setDraft(structuredClone(result.fields))
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (current()) {
          setLoading(false)
          const text = typeof error === "string" ? error : error instanceof Error ? error.message : ""
          const detail = /command.*not found|not found.*command/i.test(text) ? "Restart the current desktop build to enable these fields."
            : /lock/i.test(text) ? "Plex returned field locks that Hibiki could not read."
            : /tags/i.test(text) ? "Plex returned tag values that Hibiki could not read."
            : /section not found|library changed/i.test(text) ? "The music library could not be verified. Reconnect and retry."
            : /identity|retired detail/i.test(text) ? "The item changed while loading. Reopen its editor."
            : /structuredClone/i.test(text) ? "This webview could not copy the returned metadata."
            : "Retry when the connection is available."
          setError(
            `Could not load Plex values and locks. ${detail}`
          )
        }
      })
    return () => {
      generation.current++
    }
  }, [
    provider,
    provider?.cacheScope,
    provider?.playbackSession,
    kind,
    itemId,
    reload,
  ])
  function update(key: AdvancedMetadataKey, value: AdvancedMetadataField) {
    setDraft((previous) => ({ ...previous, [key]: value }))
    setReview(null)
    setError(null)
  }
  async function save() {
    if (
      disabled ||
      admission.current ||
      !review ||
      !baseline ||
      !provider?.editAdvancedMetadata
    )
      return
    admission.current = true
    setSaving(true)
    onSavingChange?.(true)
    const revision = generation.current,
      scope = provider.cacheScope,
      session = provider.playbackSession
    const current = () =>
      revision === generation.current &&
      useProviderStore.getState().provider === provider &&
      provider.cacheScope === scope &&
      provider.playbackSession === session
    let saved = false
    try {
      if (!current()) return
      await provider.editAdvancedMetadata(kind, itemId, review)
      if (!current()) return
      saved = true
      setReview(null)
      setReload((value) => value + 1)
    } catch {
      if (current()) {
        setReview(null)
        setError(
          "Plex did not confirm this save. Reload values and locks before retrying."
        )
        setBaseline(null)
      }
    } finally {
      admission.current = false
      if (current()) {
        setSaving(false)
        onSavingChange?.(false)
        if (saved && current()) onSaved?.()
      }
    }
  }
  if (loading)
    return (
      <p role="status" className="p-4 text-(--text-muted)">
        Loading Plex values and field locks…
      </p>
    )
  if (
    !provider?.getAdvancedMetadata ||
    !provider.editAdvancedMetadata ||
    provider.isOffline
  )
    return (
      <p className="p-4 text-(--text-muted)">
        Advanced fields require an online Plex music library.
      </p>
    )
  return (
    <section aria-label="Advanced Plex metadata" className="space-y-5">
      <p className="text-sm text-(--text-muted)">
        Changes are saved to Plex. Locked fields are protected from automatic
        metadata refresh.
      </p>
      {error && (
        <p role="alert" className="text-(--text-muted)">
          {error}
        </p>
      )}
      {!baseline && (
        <button
          type="button"
          className="metadata-edit-button"
          disabled={saving || disabled}
          onClick={() => setReload((v) => v + 1)}
        >
          Reload values and locks
        </button>
      )}
      {baseline && <div className="metadata-advanced-grid">
        {(["sortTitle", "studio", "genres", "styles", "moods", "labels", "posterLock", "backgroundLock"] as AdvancedMetadataKey[]).filter(key => !!draft[key]).map((key) => {
          const field = draft[key]!,
            unknown = field.locked === null,
            tags = Array.isArray(field.value),
            artworkLock = key === "posterLock" || key === "backgroundLock"
          return (
            <div key={key} className="metadata-edit-section space-y-3">
              <label className="metadata-edit-label">
                <span>{advancedMetadataLabels[key]}</span>
                {artworkLock ? (
                  <p className="metadata-edit-note mt-2">
                    Keep the current image when Plex refreshes metadata.
                  </p>
                ) : tags ? (
                  <textarea
                    aria-label={advancedMetadataLabels[key]}
                    disabled={unknown || saving || disabled}
                    value={(field.value as string[]).join("\n")}
                    rows={3}
                    className="metadata-edit-input normal-case"
                    onChange={(e) =>
                      update(key, {
                        ...field,
                        value: e.target.value
                          .split("\n")
                          .filter((v) => v.length > 0),
                      })
                    }
                  />
                ) : (
                  <input
                    aria-label={advancedMetadataLabels[key]}
                    disabled={unknown || saving || disabled}
                    value={field.value as string}
                    className="metadata-edit-input normal-case"
                    onChange={(e) =>
                      update(key, { ...field, value: e.target.value })
                    }
                  />
                )}
              </label>
              {unknown ? (
                <p className="text-sm text-(--text-muted)">
                  Lock state not reported by Plex.
                </p>
              ) : (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={field.locked === true}
                    className="accent-(--artwork-primary)"
                    disabled={saving || disabled}
                    onChange={(e) =>
                      update(key, { ...field, locked: e.target.checked })
                    }
                  />
                  Lock {advancedMetadataLabels[key].toLowerCase()}
                </label>
              )}
              {tags && (
                <p className="text-xs text-(--text-muted)">
                  One tag per line.
                </p>
              )}
            </div>
          )
        })}
      </div>}
      {review && (
        <div
          role="status"
          className="space-y-2 rounded border border-(--border) p-3"
        >
          <p>Review the changed values and locks before saving.</p>
          {(Object.keys(review.changes) as AdvancedMetadataKey[]).map((key) => (
            <div key={key} className="metadata-edit-preview-row">
              <p className="metadata-edit-label mb-3">{advancedMetadataLabels[key]}</p>
              <div className="metadata-edit-preview-values">{(["expected", "changes"] as const).map((side) => {
                const field = review[side][key]!, text = key === "posterLock" || key === "backgroundLock" ? "Current Plex image" : Array.isArray(field.value) ? field.value.join(", ") : field.value
                return <div key={side}><p className="metadata-edit-note mb-1">{side === "expected" ? "Current" : "After saving"}</p>
                  <p className="metadata-edit-preview-value">{text || "Empty"}</p>
                  <p className="metadata-edit-note mt-2">{field.locked ? "Locked" : "Automatic refresh allowed"}</p>
                </div>
              })}</div>
            </div>
          ))}
          <button
            type="button"
            className="metadata-edit-button metadata-edit-button--primary"
            disabled={saving || disabled}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Confirm Plex save"}
          </button>
        </div>
      )}
      {baseline && !review && (
        <button
          type="button"
          className="metadata-edit-button"
          disabled={saving || disabled || !Object.keys(draft).some(key => JSON.stringify(draft[key as AdvancedMetadataKey]) !== JSON.stringify(baseline.fields[key as AdvancedMetadataKey]))}
          onClick={() => {
            try {
              setReview(planAdvancedMetadata(baseline, draft))
              setError(null)
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Review the changed fields."
              )
            }
          }}
        >
          Review advanced changes
        </button>
      )}
    </section>
  )
}
