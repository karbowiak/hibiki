import { create } from "zustand"
import { safeLocalPersist } from "./localPreferenceStorage"
import { metadataIdentityKey } from "../metadata/core/resolve"
import type {
  MetadataField,
  MetadataIdentity,
  MetadataProviderSource,
  MetadataSelection,
} from "../metadata/core/types"
const sources: readonly MetadataProviderSource[] = [
  "plex",
  "deezer",
  "apple",
  "lastfm",
  "musicbrainz",
  "soulsync",
  "wikidata",
  "coverartarchive",
  "fanart",
  "heya",
]
const fields: readonly MetadataField[] = [
  "title",
  "artist",
  "description",
  "biography",
  "summary",
  "artwork",
  "genres",
  "tags",
  "releaseDate",
  "label",
  "fans",
  "listeners",
  "playCount",
  "trackCount",
  "mbid",
  "artistType",
  "area",
  "beginDate",
  "wikipediaUrl",
  "externalUrl",
  "similarArtists",
]
interface Choice {
  source?: MetadataProviderSource | null
  fields?: Partial<Record<MetadataField, MetadataProviderSource | null>>
}
interface MetadataSelections {
  choices: Record<string, Choice>
  setChoice(
    identity: MetadataIdentity,
    source: MetadataProviderSource | null,
    field?: MetadataField
  ): boolean
}
export function metadataSelectionKey(
  identity: MetadataIdentity
): string | null {
  if (
    !identity.scope ||
    identity.scope.length > 1024 ||
    !["artist", "album", "track"].includes(identity.kind)
  )
    return null
  if (identity.entityId?.trim())
    return identity.entityId.length <= 1024
      ? JSON.stringify([identity.scope, identity.kind, "id", identity.entityId])
      : null
  const name = (value?: string) =>
    value?.trim().replace(/\s+/g, " ").toLowerCase() ?? ""
  const artist = name(identity.artist),
    title = identity.kind === "artist" ? "" : name(identity.title)
  return artist &&
    artist.length <= 1024 &&
    (identity.kind === "artist" || title) &&
    title.length <= 1024
    ? JSON.stringify([identity.scope, identity.kind, "name", artist, title])
    : null
}
function validKey(key: string) {
  try {
    const parts = JSON.parse(key)
    return (
      Array.isArray(parts) &&
      parts.every(
        (value) => typeof value === "string" && value.length <= 1024
      ) &&
      !!parts[0] &&
      ["artist", "album", "track"].includes(parts[1]) &&
      ((parts.length === 4 && parts[2] === "id" && !!parts[3]) ||
        (parts.length === 5 &&
          parts[2] === "name" &&
          !!parts[3] &&
          (parts[1] === "artist" ? parts[4] === "" : !!parts[4])))
    )
  } catch {
    return false
  }
}
function validChoice(value: unknown): value is Choice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const choice = value as Choice
  const validSource = (source: unknown) =>
    source === null || sources.includes(source as MetadataProviderSource)
  return (
    Object.keys(choice).every((key) => key === "source" || key === "fields") &&
    (choice.source === undefined || validSource(choice.source)) &&
    (choice.fields === undefined ||
      (!!choice.fields &&
        typeof choice.fields === "object" &&
        !Array.isArray(choice.fields) &&
        Object.entries(choice.fields).every(
          ([field, source]) =>
            fields.includes(field as MetadataField) && validSource(source)
        )))
  )
}
export function metadataSelectionFor(
  identity: MetadataIdentity,
  choices: Record<string, Choice>
): MetadataSelection | undefined {
  const key = metadataSelectionKey(identity),
    choice = key ? choices[key] : undefined
  if (!choice) return undefined
  return {
    scope: identity.scope,
    identityKey: metadataIdentityKey(identity),
    source: choice.source ?? undefined,
    fields: Object.fromEntries(
      Object.entries(choice.fields ?? {}).filter(
        ([, source]) => source !== null
      )
    ) as MetadataSelection["fields"],
  }
}
export function createMetadataSelectionStore(persist = safeLocalPersist) {
  return create<MetadataSelections>()(
    persist(
      (set, get) => ({
        choices: {},
        setChoice(identity, source, field) {
          const key = metadataSelectionKey(identity)
          if (
            !key ||
            (source !== null && !sources.includes(source)) ||
            (field && !fields.includes(field))
          )
            return false
          if (
            !Object.hasOwn(get().choices, key) &&
            Object.keys(get().choices).length >= 4096
          )
            return false
          // Null tombstones preserve Automatic intent during delayed recovery/hydration;
          // resetting one field never clears other fields or the per-item choice.
          set((state) => {
            const previous = state.choices[key] ?? {}
            return {
              choices: {
                ...state.choices,
                [key]: field
                  ? {
                      ...previous,
                      fields: { ...previous.fields, [field]: source },
                    }
                  : { ...previous, source },
              },
            }
          })
          return true
        },
      }),
      {
        name: "metadata-source-selections-v1",
        partialize: (state) => ({ choices: state.choices }),
        validate: (saved) =>
          saved.choices === undefined ||
          (!!saved.choices &&
            typeof saved.choices === "object" &&
            !Array.isArray(saved.choices) &&
            Object.keys(saved.choices).length <= 4096 &&
            Object.entries(saved.choices).every(
              ([key, choice]) => validKey(key) && validChoice(choice)
            )),
      }
    )
  )
}
export const useMetadataSelectionStore = createMetadataSelectionStore()
