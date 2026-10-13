import { create } from "zustand"
import { safeLocalPersist } from "./localPreferenceStorage"
import type { MetadataIdentity } from "../metadata/core/types"
import type {
  MetadataIdentityCandidate,
  ReviewedMetadataIdentity,
} from "../metadata/identity/types"
export interface MetadataIdentityChoice {
  candidate: MetadataIdentityCandidate
  libraryArtist: string
  libraryTitle?: string
  version: string
}
interface State {
  choices: Record<string, MetadataIdentityChoice | null>
  versions: Record<string, number>
  hydrated: boolean
  setReviewed(
    identity: MetadataIdentity,
    review: ReviewedMetadataIdentity
  ): boolean
  reset(identity: MetadataIdentity): boolean
}
const normalized = (value?: string) =>
  value?.trim().replace(/\s+/g, " ").toLowerCase() ?? ""
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const text = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= 512
export function metadataIdentityItemKey(
  identity: MetadataIdentity
): string | null {
  if (
    !identity.scope ||
    identity.scope.length > 1024 ||
    !["artist", "album"].includes(identity.kind)
  )
    return null
  if (identity.entityId?.trim())
    return identity.entityId.length <= 1024
      ? JSON.stringify([identity.scope, identity.kind, "id", identity.entityId])
      : null
  const artist = normalized(identity.artist),
    title = identity.kind === "artist" ? "" : normalized(identity.title)
  return artist &&
    artist.length <= 512 &&
    (identity.kind === "artist" || title) &&
    title.length <= 512
    ? JSON.stringify([identity.scope, identity.kind, "name", artist, title])
    : null
}
export function validIdentityCandidate(
  value: unknown
): value is MetadataIdentityCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const c = value as MetadataIdentityCandidate
  const fields = [
    "provider",
    "kind",
    "id",
    "title",
    "artist",
    "aliases",
    "disambiguation",
    "artistType",
    "area",
    "releaseDate",
    "artistCredits",
    "identifiers",
    "connectionId",
  ]
  return (
    Object.keys(c).every((key) => fields.includes(key)) &&
    ["musicbrainz", "heya"].includes(c.provider) &&
    ["artist", "album"].includes(c.kind) &&
    uuid(c.id) &&
    text(c.title) &&
    text(c.artist) &&
    [c.disambiguation, c.artistType, c.area, c.releaseDate].every(
      (v) => v === undefined || (typeof v === "string" && v.length <= 512)
    ) &&
    Array.isArray(c.aliases) &&
    c.aliases.length <= 32 &&
    c.aliases.every(
      (a) =>
        !!a &&
        Object.keys(a).every((k) => ["name", "locale", "type"].includes(k)) &&
        text(a.name) &&
        [a.locale, a.type].every(
          (v) => v === undefined || (typeof v === "string" && v.length <= 64)
        )
    ) &&
    Array.isArray(c.artistCredits) &&
    c.artistCredits.length <= 16 &&
    c.artistCredits.every(
      (a) =>
        !!a &&
        Object.keys(a).every((k) => ["name", "mbid"].includes(k)) &&
        text(a.name) &&
        (a.mbid === undefined || uuid(a.mbid))
    ) &&
    !!c.identifiers &&
    Object.keys(c.identifiers).every((k) =>
      ["artistMbid", "releaseGroupMbid", "wikidataQid"].includes(k)
    ) &&
    Object.entries(c.identifiers).every(([key, value]) =>
      key === "wikidataQid"
        ? typeof value === "string" && /^Q[1-9][0-9]{0,18}$/.test(value)
        : uuid(value)
    ) &&
    (c.provider !== "musicbrainz" ||
      (c.kind === "artist"
        ? c.identifiers.artistMbid === c.id
        : c.identifiers.releaseGroupMbid === c.id)) &&
    (c.provider === "heya"
      ? uuid(c.connectionId)
      : c.connectionId === undefined) &&
    (c.kind === "artist"
      ? c.identifiers.releaseGroupMbid === undefined
      : true) &&
    JSON.stringify(c).length <= 12000
  )
}
function validKey(key: string) {
  try {
    const p = JSON.parse(key)
    return (
      Array.isArray(p) &&
      ((p.length === 4 && p[2] === "id") ||
        (p.length === 5 && p[2] === "name")) &&
      p.every((v: unknown) => typeof v === "string" && v.length <= 1024) &&
      !!p[0] &&
      ["artist", "album"].includes(p[1]) &&
      !!p[3] &&
      (p[2] === "id" || (p[1] === "artist" ? p[4] === "" : !!p[4]))
    )
  } catch {
    return false
  }
}
function validChoice(choice: unknown): choice is MetadataIdentityChoice | null {
  if (choice === null) return true
  if (!choice || typeof choice !== "object" || Array.isArray(choice))
    return false
  const c = choice as MetadataIdentityChoice
  return (
    Object.keys(c).every((k) =>
      ["candidate", "libraryArtist", "libraryTitle", "version"].includes(k)
    ) &&
    validIdentityCandidate(c.candidate) &&
    text(c.libraryArtist) &&
    (c.libraryTitle === undefined || text(c.libraryTitle)) &&
    uuid(c.version)
  )
}
export function identityChoiceFor(
  identity: MetadataIdentity,
  choices: State["choices"]
): MetadataIdentityChoice | null {
  const key = metadataIdentityItemKey(identity)
  if (key && Object.hasOwn(choices, key)) return choices[key]
  if (identity.entityId?.trim()) return null
  // Old card callers omit IDs. Only an unambiguous scoped name mapping may
  // borrow a reviewed choice; same-name different artists never collapse.
  const matching = Object.entries(choices)
    .filter(([key, choice]) => {
      if (!choice) return false
      const [scope, kind] = JSON.parse(key)
      return (
        scope === identity.scope &&
        kind === identity.kind &&
        normalized(choice.libraryArtist) === normalized(identity.artist) &&
        (kind === "artist" ||
          normalized(choice.libraryTitle) === normalized(identity.title))
      )
    })
    .map(([, choice]) => choice!)
  if (!matching.length) return null
  const signature = (c: MetadataIdentityChoice) =>
    JSON.stringify([
      c.candidate.provider,
      c.candidate.id,
      c.candidate.connectionId ?? null,
    ])
  return matching.every((c) => signature(c) === signature(matching[0]))
    ? matching[0]
    : null
}
export function createMetadataIdentityStore(persist = safeLocalPersist) {
  const store = create<State>()(
    persist(
      (set, get) => ({
        choices: {},
        versions: {},
        hydrated: false,
        setReviewed(identity, review) {
          const key = metadataIdentityItemKey(identity)
          if (
            !key ||
            !validIdentityCandidate(review.candidate) ||
            review.candidate.kind !== identity.kind ||
            !Number.isFinite(review.reviewedAt) ||
            review.reviewedAt <= 0 ||
            !text(identity.artist) ||
            (identity.kind === "album" && !text(identity.title))
          )
            return false
          if (
            !Object.hasOwn(get().choices, key) &&
            Object.keys(get().choices).length >= 512
          )
            return false
          set((state) => ({
            choices: {
              ...state.choices,
              [key]: {
                candidate: review.candidate,
                libraryArtist: identity.artist,
                libraryTitle:
                  identity.kind === "album" ? identity.title : undefined,
                version: crypto.randomUUID(),
              },
            },
            versions: {
              ...state.versions,
              [key]: (state.versions[key] ?? 0) + 1,
            },
          }))
          return true
        },
        reset(identity) {
          const key = metadataIdentityItemKey(identity)
          if (
            !key ||
            (!Object.hasOwn(get().choices, key) &&
              Object.keys(get().choices).length >= 512)
          )
            return false
          set((state) => ({
            choices: { ...state.choices, [key]: null },
            versions: {
              ...state.versions,
              [key]: (state.versions[key] ?? 0) + 1,
            },
          }))
          return true
        },
      }),
      {
        name: "metadata-reviewed-identities-v1",
        partialize: (state) => ({ choices: state.choices }),
        validate: (saved) =>
          saved.choices === undefined ||
          (!!saved.choices &&
            typeof saved.choices === "object" &&
            !Array.isArray(saved.choices) &&
            Object.keys(saved.choices).length <= 512 &&
            Object.entries(saved.choices).every(
              ([key, choice]) =>
                validKey(key) &&
                validChoice(choice) &&
                (choice === null ||
                  (() => {
                    const parts = JSON.parse(key)
                    return (
                      choice.candidate.kind === parts[1] &&
                      (parts[2] !== "name" ||
                        (parts[3] === normalized(choice.libraryArtist) &&
                          parts[4] ===
                            (parts[1] === "artist"
                              ? ""
                              : normalized(choice.libraryTitle))))
                    )
                  })())
            )),
        onRehydrateStorage: () => (state, error) => {
          if (state && !error) store.setState({ hydrated: true })
        },
      }
    )
  )
  return store
}
export const useMetadataIdentityStore = createMetadataIdentityStore()
