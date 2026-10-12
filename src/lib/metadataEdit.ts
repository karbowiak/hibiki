import type {
  LibraryMetadataExpected,
  LibraryMetadataPatch,
} from "../providers/types"
import type { MusicAlbum, MusicArtist, MusicPlaylist } from "../types/music"

export type MetadataEditItem = MusicArtist | MusicAlbum | MusicPlaylist
export type MetadataEditKind = "artist" | "album" | "playlist"
export interface MetadataEditDraft {
  title: string
  summary: string
  releaseDate: string
}
export interface MetadataEditChange {
  field: keyof MetadataEditDraft
  label: string
  before: string
  after: string
}
export function metadataEditDraft(
  kind: MetadataEditKind,
  item: MetadataEditItem
): MetadataEditDraft {
  return {
    title: item.title,
    summary: item.summary ?? "",
    releaseDate:
      kind === "album" ? ((item as MusicAlbum).releaseDate ?? "") : "",
  }
}
export function planMetadataEdit(
  kind: MetadataEditKind,
  item: MetadataEditItem,
  draft: MetadataEditDraft
) {
  const title = draft.title.trim(),
    summary = draft.summary
  if (!title) throw new Error("Enter a title.")
  for (const [field, value, limit] of [
    ["Title", title, 512],
    ["Description", summary, 16000],
  ] as const) {
    if ([...value].length > limit)
      throw new Error(`${field} is too long (maximum ${limit} characters).`)
    if (
      (field === "Title"
        ? /[\x00-\x1f\x7f]/
        : /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
      ).test(value)
    )
      throw new Error(`${field} contains an unsupported control character.`)
  }
  const patch: LibraryMetadataPatch = {},
    expected: LibraryMetadataExpected = {},
    changes: MetadataEditChange[] = []
  const baseline = metadataEditDraft(kind, item)
  const add = (
    field: keyof MetadataEditDraft,
    label: string,
    value: string,
    original: string | null
  ) => {
    if (value === baseline[field]) return
    patch[field] = value
    expected[field] = original
    changes.push({ field, label, before: baseline[field], after: value })
  }
  add("title", "Title", title, item.title)
  add("summary", "Description", summary, item.summary)
  if (kind === "album") {
    const date = draft.releaseDate
    if (date !== baseline.releaseDate) {
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? new Date(`${date}T00:00:00Z`)
        : null
      if (
        !parsed ||
        !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date
      )
        throw new Error("Enter a valid release date (YYYY-MM-DD).")
      add(
        "releaseDate",
        "Release date",
        date,
        (item as MusicAlbum).releaseDate ?? null
      )
    }
  }
  return { patch, expected, changes }
}

/** Only recognized, sanitized native errors are presented to the user. */
export function metadataEditError(error: unknown): {
  message: string
  reload: boolean
} {
  const text = (
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : ""
  ).toLowerCase()
  if (text.includes("metadata changed"))
    return {
      message:
        "This item changed in Plex. Reload its current values and review your edits again.",
      reload: true,
    }
  if (text.includes("outcome") || text.includes("may have") || text.includes("did not confirm"))
    return {
      message:
        "Plex did not confirm the save. Reload its current values before trying again.",
      reload: true,
    }
  if (
    text.includes("permission") ||
    text.includes("forbidden") ||
    text.includes("401") ||
    text.includes("403")
  )
    return {
      message:
        "Plex rejected the edit. Check that this account can manage this library.",
      reload: false,
    }
  if (text.includes("command") && text.includes("not found"))
    return {
      message:
        "Restart Hibiki with the current desktop build to enable editing.",
      reload: false,
    }
  return {
    message:
      "Could not confirm the save. Reload the item to check its current values before trying again.",
    reload: true,
  }
}
