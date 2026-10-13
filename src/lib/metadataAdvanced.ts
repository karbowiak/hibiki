export type AdvancedMetadataKey =
  | "sortTitle"
  | "studio"
  | "genres"
  | "styles"
  | "moods"
  | "labels"
  | "posterLock"
  | "backgroundLock"
export interface AdvancedMetadataField {
  value: string | string[]
  locked: boolean | null
}
export interface AdvancedMetadata {
  itemId: number
  kind: "artist" | "album"
  fields: Partial<Record<AdvancedMetadataKey, AdvancedMetadataField>>
}
export interface AdvancedMetadataPatch {
  expected: Partial<Record<AdvancedMetadataKey, AdvancedMetadataField>>
  changes: Partial<Record<AdvancedMetadataKey, AdvancedMetadataField>>
}
export const advancedMetadataLabels: Record<AdvancedMetadataKey, string> = {
  sortTitle: "Sort title",
  studio: "Studio / record label",
  genres: "Genres",
  styles: "Styles",
  moods: "Moods",
  labels: "Labels",
  posterLock: "Plex poster",
  backgroundLock: "Plex background",
}
export function planAdvancedMetadata(
  baseline: AdvancedMetadata,
  draft: AdvancedMetadata["fields"]
): AdvancedMetadataPatch {
  const expected: AdvancedMetadataPatch["expected"] = {},
    changes: AdvancedMetadataPatch["changes"] = {}
  for (const key of Object.keys(draft) as AdvancedMetadataKey[]) {
    const before = baseline.fields[key],
      next = draft[key]
    if (!before || !next)
      throw Error("Reload the original metadata before editing.")
    if (JSON.stringify(before) === JSON.stringify(next)) continue
    if (before.locked === null || next.locked === null)
      throw Error(
        "Plex did not return an explicit field lock. Reload before editing."
      )
    if (
      (key === "posterLock" || key === "backgroundLock") &&
      before.value !== next.value
    )
      throw Error("Artwork values cannot change through lock controls.")
    const tags = ["genres", "styles", "moods", "labels"].includes(key)
    if (tags !== Array.isArray(next.value))
      throw Error("Invalid metadata field type.")
    const values = Array.isArray(next.value) ? next.value : [next.value]
    if (
      values.length > 64 ||
      values.some(
        (value) => [...value].length > 512 || /[\x00-\x1f\x7f]/.test(value)
      )
    )
      throw Error("Metadata values exceed supported bounds.")
    if (
      tags &&
      (values.some((value) => !value.trim()) ||
        new Set(values).size !== values.length)
    )
      throw Error("Tags must be unique and nonempty.")
    if (
      tags &&
      JSON.stringify([...(before.value as string[])].sort()) ===
        JSON.stringify([...(next.value as string[])].sort()) &&
      before.locked === next.locked
    )
      continue
    expected[key] = structuredClone(before)
    changes[key] = structuredClone(next)
  }
  if (!Object.keys(changes).length)
    throw Error("No advanced metadata changes to save.")
  return { expected, changes }
}
