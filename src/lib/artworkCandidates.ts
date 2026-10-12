import type { ArtworkSource } from "../stores/artworkPreferenceStore"

/** Candidates have already passed provider identity validation. Saved IDs are never URLs. */
export interface ArtworkCandidate {
  id: string
  url: string
  label?: string
  provenance?: string
}
export function selectedArtworkCandidate(
  images: readonly ArtworkCandidate[],
  source: ArtworkSource,
  saved: { source: ArtworkSource; id: string } | null | undefined
): ArtworkCandidate | null {
  if (saved?.source === source)
    return images.find((image) => image.id === saved.id) ?? null
  return images[0] ?? null
}

/** A missing saved candidate cannot silently become another image from that source. */
export function resolveArtworkCandidates(
  images: Partial<Record<ArtworkSource, readonly ArtworkCandidate[]>>,
  priority: readonly string[],
  preference: ArtworkSource | null,
  saved: { source: ArtworkSource; id: string } | null | undefined,
  failedUrls: readonly string[] = []
) {
  const selected = Object.fromEntries(
    Object.entries(images).map(([source, values]) => {
      const candidate = selectedArtworkCandidate(
        values ?? [],
        source as ArtworkSource,
        saved
      )
      return [source, candidate?.url ?? null]
    })
  ) as Partial<Record<ArtworkSource, string | null>>
  const source = priority.find(
    (source) =>
      selected[source as ArtworkSource] &&
      !failedUrls.includes(selected[source as ArtworkSource]!)
  ) as ArtworkSource | undefined
  return {
    source: source ?? null,
    url: source ? selected[source]! : null,
    refreshTargets: selected,
    fallback: !!preference && source !== preference,
  }
}

/** Defense in depth for provider arrays before building managed image URIs. */
export function verifiedFanartCandidates(
  values: readonly ArtworkCandidate[]
): ArtworkCandidate[] {
  const candidates: ArtworkCandidate[] = []
  const seen = new Set<string>()
  for (const value of values.slice(0, 12)) {
    if (
      !value ||
      typeof value.id !== "string" ||
      typeof value.url !== "string" ||
      !value.id ||
      value.id.length > 512 ||
      /[\x00-\x1f]/.test(value.id) ||
      seen.has(value.id)
    )
      continue
    try {
      const url = new URL(value.url)
      if (
        url.protocol !== "https:" ||
        url.hostname !== "assets.fanart.tv" ||
        url.username ||
        url.password ||
        (url.port && url.port !== "443")
      )
        continue
      seen.add(value.id)
      candidates.push({
        id: value.id,
        url: url.toString(),
        ...(typeof value.label === "string" && value.label
          ? { label: value.label.slice(0, 120) }
          : {}),
      })
    } catch {
      /* Invalid provider values are unavailable, never request targets. */
    }
  }
  return candidates
}

/** Only native-verified opaque Heya references can enter the image pipeline. */
export function verifiedHeyaCandidates(
  values: readonly ArtworkCandidate[],
  revision: string
): ArtworkCandidate[] {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuid.test(revision)) return []
  const seen = new Set<string>()
  const result: ArtworkCandidate[] = []
  for (const value of values.slice(0, 12)) {
    if (
      !value ||
      typeof value.id !== "string" ||
      !uuid.test(value.id) ||
      typeof value.url !== "string" ||
      seen.has(value.id)
    )
      continue
    try {
      const url = new URL(value.url)
      if (
        url.protocol !== "heyametadata:" ||
        url.hostname !== "image" ||
        url.username ||
        url.password ||
        url.port ||
        url.hash ||
        url.pathname !== `/${value.id}` ||
        url.searchParams.getAll("serviceRevision").length !== 1 ||
        url.searchParams.get("serviceRevision") !== revision ||
        [...url.searchParams.keys()].some((key) => key !== "serviceRevision")
      )
        continue
      seen.add(value.id)
      result.push({
        id: value.id,
        url: url.toString(),
        ...(typeof value.label === "string"
          ? { label: value.label.slice(0, 120) }
          : {}),
      })
    } catch {
      /* Invalid references never become request URLs. */
    }
  }
  return result
}
