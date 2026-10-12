import { create } from "zustand"
import { safePersist } from "./idbStorage"
export type ArtworkSource = "plex" | "deezer" | "apple"
export type ArtworkKind = "artist" | "album"
export function artworkPreferenceKey(
  scope: string | null | undefined,
  kind: ArtworkKind,
  artist: string | null,
  album?: string | null
): string | null {
  const name = artist?.trim().toLowerCase()
  const title = album?.trim().toLowerCase()
  return scope && name && (kind === "artist" || title)
    ? JSON.stringify([scope, kind, name, kind === "album" ? title : ""])
    : null
}
export function artworkRevisionKey(
  scope: string | null | undefined,
  url: string | null
): string | null {
  if (!scope || !url) return null
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete("revision")
    return JSON.stringify([scope, parsed.toString()])
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
  revisions: Record<string, string>
  rememberRevision: (scope: string, url: string, revision: string) => void
  setChoice: (key: string, source: ArtworkSource | null) => void
}
function validKey(key: string, source: unknown) {
  try {
    const parts = JSON.parse(key)
    return (
      Array.isArray(parts) &&
      parts.length === 4 &&
      parts.every((x) => typeof x === "string") &&
      !!parts[0] &&
      !!parts[2] &&
      ((parts[1] === "artist" && parts[3] === "" && source !== "apple") ||
        (parts[1] === "album" && !!parts[3])) &&
      (source === null ||
        ["plex", "deezer", "apple"].includes(source as string))
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
        rememberRevision: (scope, url, revision) => {
          const key = artworkRevisionKey(scope, url)
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
          set((s) => ({ choices: { ...s.choices, [key]: source } }))
        },
      }),
      {
        name: "artwork-source-choices-v1",
        partialize: (s) => ({ choices: s.choices }),
        validate: (saved) =>
          saved.choices === undefined ||
          (saved.choices !== null &&
            typeof saved.choices === "object" &&
            !Array.isArray(saved.choices) &&
            Object.entries(saved.choices).every(([key, source]) =>
              validKey(key, source)
            )),
      }
    )
  )
}
export const useArtworkPreferenceStore = createArtworkPreferenceStore()
