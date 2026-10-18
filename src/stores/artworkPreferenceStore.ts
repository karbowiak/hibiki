import { create } from "zustand"
import { safePersist } from "./sqliteStorage"
export type ArtworkSource =
  "plex" | "deezer" | "apple" | "coverartarchive" | "fanart" | "heya" | "theaudiodb"
export type ArtworkKind = "artist" | "album"
export type ArtworkRole = "poster" | "background"
export function artworkPreferenceKey(
  scope: string | null | undefined,
  kind: ArtworkKind,
  artist: string | null,
  album?: string | null,
  role: ArtworkRole = "poster"
): string | null {
  const name = artist?.trim().toLowerCase()
  const title = album?.trim().toLowerCase()
  return scope && name && (kind === "artist" || title)
    ? JSON.stringify([
        scope,
        kind,
        name,
        kind === "album" ? title : "",
        ...(role === "background" ? [role] : []),
      ])
    : null
}
export function artworkRevisionKey(
  scope: string | null | undefined,
  url: string | null,
  role: ArtworkRole = "poster"
): string | null {
  if (!scope || !url) return null
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete("revision")
    return JSON.stringify([
      scope,
      parsed.toString(),
      ...(role === "background" ? [role] : []),
    ])
  } catch {
    return null
  }
}
export function applyArtworkRevision(
  url: string | null,
  revision: string | undefined
): string | null {
  if (!url || !revision) return url
  try {
    const parsed = new URL(url)
    parsed.searchParams.set("revision", revision)
    return parsed.toString()
  } catch {
    return url
  }
}
interface ArtworkPreferences {
  choices: Record<string, ArtworkSource | null>
  candidateChoices: Record<string, { source: ArtworkSource; id: string } | null>
  setCandidate: (key: string, source: ArtworkSource, id: string) => void
  revisions: Record<string, string>
  rememberRevision: (
    scope: string,
    url: string,
    revision: string,
    role?: ArtworkRole
  ) => void
  setChoice: (key: string, source: ArtworkSource | null) => void
}
function validKey(key: string, source: unknown) {
  try {
    const parts = JSON.parse(key)
    return (
      Array.isArray(parts) &&
      (parts.length === 4 ||
        (parts.length === 5 && parts[4] === "background")) &&
      parts.every((x) => typeof x === "string") &&
      !!parts[0] &&
      !!parts[2] &&
      ((parts[1] === "artist" &&
        parts[3] === "" &&
        source !== "apple" &&
        source !== "coverartarchive") ||
        (parts[1] === "album" && !!parts[3])) &&
      (source === null ||
        [
          "plex",
          "deezer",
          "apple",
          "coverartarchive",
          "fanart",
          "heya",
          "theaudiodb",
        ].includes(source as string))
    )
  } catch {
    return false
  }
}
export function createArtworkPreferenceStore(persist = safePersist) {
  return create<ArtworkPreferences>()(
    persist(
      (set) => ({
        choices: {},
        revisions: {},
        candidateChoices: {},
        setCandidate: (key, source, id) => {
          if (
            !validKey(key, source) ||
            !id ||
            id.length > 512 ||
            /[\x00-\x1f]/.test(id)
          )
            return
          set((s) => ({
            choices: { ...s.choices, [key]: source },
            candidateChoices: { ...s.candidateChoices, [key]: { source, id } },
          }))
        },
        rememberRevision: (scope, url, revision, role = "poster") => {
          const key = artworkRevisionKey(scope, url, role)
          if (!key || !/^[a-zA-Z0-9_-]{1,128}$/.test(revision)) return
          set((s) => ({
            revisions: Object.fromEntries([
              ...Object.entries(s.revisions)
                .filter(([old]) => old !== key)
                .slice(-511),
              [key, revision],
            ]),
          }))
        },
        setChoice: (key, source) => {
          if (!validKey(key, source)) return
          // An explicit Automatic tombstone is intent too, including before hydration.
          set((s) => ({
            choices: { ...s.choices, [key]: source },
            candidateChoices: { ...s.candidateChoices, [key]: null },
          }))
        },
      }),
      {
        name: "artwork-source-choices-v1",
        partialize: (s) => ({
          choices: s.choices,
          candidateChoices: s.candidateChoices,
        }),
        validate: (saved) =>
          (saved.candidateChoices === undefined ||
            (saved.candidateChoices !== null &&
              typeof saved.candidateChoices === "object" &&
              !Array.isArray(saved.candidateChoices) &&
              Object.entries(saved.candidateChoices).every(
                ([key, value]) =>
                  (value === null && validKey(key, null)) ||
                  (typeof value === "object" &&
                    value !== null &&
                    validKey(key, (value as any).source) &&
                    typeof (value as any).id === "string" &&
                    (value as any).id.length > 0 &&
                    (value as any).id.length <= 512 &&
                    !/[\x00-\x1f]/.test((value as any).id))
              ))) &&
          (saved.choices === undefined ||
            (saved.choices !== null &&
              typeof saved.choices === "object" &&
              !Array.isArray(saved.choices) &&
              Object.entries(saved.choices).every(([key, source]) =>
                validKey(key, source)
              ))),
      }
    )
  )
}
export const useArtworkPreferenceStore = createArtworkPreferenceStore()
