import { useState, useEffect } from "react"
import { useHeyaDiscovery } from "../../hooks/useHeyaDiscovery"
import type { MetadataIdentity } from "../../metadata/core/types"
import type { ReviewedMetadataIdentity } from "../../metadata/identity/types"
/** Discovery may create canonical service data. Only explicit user actions
 * start discovery/resolve; canonical review still uses the existing Apply step. */
export function HeyaDiscoveryPanel({
  identity,
  onReviewed,
  disabled = false,
}: {
  identity: MetadataIdentity
  onReviewed: (review: ReviewedMetadataIdentity, lease: string) => boolean
  disabled?: boolean
}) {
  const discovery = useHeyaDiscovery(identity, onReviewed)
  const [query, setQuery] = useState(
    identity.kind === "artist" ? identity.artist : (identity.title ?? "")
  )
  useEffect(
    () =>
      setQuery(
        identity.kind === "artist" ? identity.artist : (identity.title ?? "")
      ),
    [
      identity.scope,
      identity.entityId,
      identity.kind,
      identity.artist,
      identity.title,
    ]
  )
  if (identity.kind === "track" || discovery.offline || !discovery.capability)
    return null
  if (!discovery.capability.available)
    return (
      <div className="metadata-edit-note">
        <p>{discovery.capability.reason}</p>
        {discovery.capability.retryable && (
          <button
            type="button"
            className="metadata-edit-button mt-2"
            disabled={disabled}
            onClick={discovery.retryAvailability}
          >
            Check discovery availability
          </button>
        )}
      </div>
    )
  const locked = disabled || discovery.loading
  return (
    <section
      className="metadata-edit-section"
      aria-label="Discover missing HeyaMetadata identities"
    >
      <h4 className="metadata-edit-section-title">
        Missing from HeyaMetadata?
      </h4>
      <p className="metadata-edit-note">
        Ask your configured server to discover this artist or album. This can
        create metadata and background jobs on that server; your Plex library
        stays unchanged.
      </p>
      <label className="metadata-edit-field mt-3">
        <span>Discovery query</span>
        <input
          className="metadata-edit-input"
          value={query}
          maxLength={512}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <button
        className="metadata-edit-button mt-3"
        type="button"
        disabled={locked || !query.trim() || !!discovery.progress}
        onClick={() => void discovery.start(query)}
      >
        Discover with HeyaMetadata
      </button>
      {discovery.loading && (
        <p className="metadata-edit-note mt-3" role="status">
          Checking discovery…
        </p>
      )}
      {discovery.progress &&
        !discovery.loading &&
        !discovery.progress.canonicalId &&
        discovery.progress.state !== "needs-selection" &&
        discovery.progress.state !== "failed" && (
          <div className="mt-3">
            <p className="metadata-edit-note" role="status">
              Discovery is still running. Automatic checks stop after a minute.
            </p>
            <button
              className="metadata-edit-button mt-2"
              type="button"
              disabled={locked}
              onClick={() => void discovery.check()}
            >
              Check discovery status
            </button>
          </div>
        )}
      {discovery.progress?.state === "needs-selection" && (
        <div className="mt-3 space-y-2" aria-label="Discovery candidates">
          <p className="metadata-edit-note">
            Choose a candidate to resolve on the server, then review its
            canonical identity before applying it.
          </p>
          {discovery.progress.candidates.map((candidate) => (
            <button
              className="metadata-edit-section w-full text-left hover:bg-app-surface-hover"
              type="button"
              disabled={locked}
              key={candidate.reference}
              onClick={() => void discovery.select(candidate.reference)}
            >
              <span className="block font-semibold">{candidate.name}</span>
              <span className="metadata-edit-note">
                {[
                  candidate.artists.join(" · "),
                  candidate.disambiguation,
                  candidate.year,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="metadata-edit-note mt-2 block text-xs">
                Resolve this candidate →
              </span>
            </button>
          ))}
          {!discovery.progress.candidates.length && (
            <p className="metadata-edit-note">
              No reviewable identities were found. Try existing identity search
              with another spelling.
            </p>
          )}
        </div>
      )}
      {discovery.progress?.canonicalId && !discovery.previewed && (
        <button
          className="metadata-edit-button mt-3"
          type="button"
          disabled={locked}
          onClick={() => void discovery.review()}
        >
          Review discovered identity
        </button>
      )}
      {discovery.previewed && (
        <p className="metadata-edit-note mt-3" role="status">
          The exact identity is ready in the preview. Review it and use Apply
          this identity to save your choice.
        </p>
      )}
      {discovery.progress?.state === "failed" && (
        <p className="metadata-edit-note mt-3" role="alert">
          The server could not complete discovery. Search existing identities or
          reopen this panel later.
        </p>
      )}
      {discovery.error && (
        <p className="metadata-edit-note mt-3" role="alert">
          {discovery.error}
        </p>
      )}
    </section>
  )
}
