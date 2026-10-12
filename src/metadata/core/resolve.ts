import type {
  MetadataProviderSource,
  MetadataField,
  MetadataFields,
  MetadataIdentity,
  MetadataSelection,
  MetadataSnapshot,
  ResolvedMetadataField,
} from "./types"
export const metadataIdentityKey = (identity: MetadataIdentity): string =>
  JSON.stringify([
    identity.kind,
    identity.entityId ?? null,
    identity.artist.trim().replace(/\s+/g, " ").toLowerCase(),
    identity.title?.trim().replace(/\s+/g, " ").toLowerCase() ?? null,
  ])
export function resolveMetadataField<K extends MetadataField>(
  field: K,
  identity: MetadataIdentity,
  snapshots: readonly MetadataSnapshot[],
  priority: readonly MetadataProviderSource[],
  selection?: MetadataSelection
): ResolvedMetadataField<K> | null {
  const validSelection =
    selection?.scope === identity.scope &&
    selection.identityKey === metadataIdentityKey(identity)
      ? selection
      : undefined
  // Library names remain authoritative; source preferences affect enrichment only.
  const chosen =
    field === "title" || field === "artist"
      ? "plex"
      : (validSelection?.fields?.[field] ?? validSelection?.source)
  const order =
    field === "title" || field === "artist"
      ? ["plex"]
      : [...new Set([...(chosen ? [chosen] : []), ...priority])]
  for (const source of order) {
    const snapshot = snapshots.find(
      (candidate) =>
        candidate.source === source &&
        candidate.identity.scope === identity.scope &&
        metadataIdentityKey(candidate.identity) ===
          metadataIdentityKey(identity) &&
        candidate.match.kind !== "candidate"
    )
    const value = snapshot?.fields[field]
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && !value.length)
    )
      continue
    return {
      value: value as MetadataFields[K],
      source: snapshot!.source,
      match: snapshot!.match,
      observedAt: snapshot!.observedAt,
      origin: snapshot!.fieldOrigins?.[field],
      fallback: !!chosen && chosen !== source,
    }
  }
  return null
}
