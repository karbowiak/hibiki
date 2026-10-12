import { create } from "zustand"
import { invoke } from "@tauri-apps/api/core"
import { useHeyaServiceStore } from "../services/store"
import { useMusicBrainzMetadataStore } from "../musicbrainz/store"
import { albumMatches } from "../albumMatch"
import {
  verifiedHeyaCandidates,
  type ArtworkCandidate,
} from "../../lib/artworkCandidates"
import type { CacheEntry } from "../../stores/createMetadataStore"

export interface HeyaArtwork {
  id: string
  artist: string
  title: string | null
  revision: string
  posters: ArtworkCandidate[]
  backgrounds: ArtworkCandidate[]
}
type Lookup =
  | { status: "ready"; item: HeyaArtwork }
  | { status: "unavailable" | "ambiguous" }
type ArtworkEntry = CacheEntry<HeyaArtwork> & { revision: string }
interface State {
  artists: Record<string, ArtworkEntry>
  albums: Record<string, ArtworkEntry>
  _loadingArtists: Record<string, true>
  _loadingAlbums: Record<string, true>
  _hasHydrated: boolean
  getArtist(artist: string): Promise<HeyaArtwork | null>
  getAlbum(artist: string, title: string): Promise<HeyaArtwork | null>
  invalidateArtist(artist: string): void
  invalidateAlbum(artist: string, title: string): void
  clearCache(): void
}
const TTL = 30 * 60 * 1000
const keyFor = (artist: string, title?: string) =>
  title === undefined
    ? artist.toLowerCase()
    : `${artist.toLowerCase()}::${title.toLowerCase()}`
const bounded = <T>(
  entries: Record<string, T>,
  key: string,
  value: T
): Record<string, T> =>
  Object.fromEntries([
    ...Object.entries(entries)
      .filter(([old]) => old !== key)
      .slice(-31),
    [key, value],
  ])
/** Memory-only: every app launch must verify native detail and register image IDs.
 * Durable user selections store only source+ID in artworkPreferenceStore. */
export function createHeyaArtworkStore(
  lookup: (args: {
    revision: string
    kind: "artist" | "album"
    artist: string
    title: string | null
    mbid: string | null
  }) => Promise<Lookup> = (args) => invoke("heya_get_metadata", args)
) {
  let epoch = 0,
    pending = 0
  const inflight = new Map<string, Promise<HeyaArtwork | null>>()
  const store = create<State>((set, get) => {
    const invalidate = (kind: "artist" | "album", key: string) => {
      inflight.delete(`${kind}:${key}`)
      const field = kind === "artist" ? "artists" : "albums"
      const loading = kind === "artist" ? "_loadingArtists" : "_loadingAlbums"
      set((s) => ({
        [field]: Object.fromEntries(
          Object.entries(s[field]).filter(([old]) => old !== key)
        ),
        [loading]: Object.fromEntries(
          Object.entries(s[loading]).filter(([old]) => old !== key)
        ),
      }))
    }
    const fetch = async (
      kind: "artist" | "album",
      artist: string,
      title?: string
    ): Promise<HeyaArtwork | null> => {
      const status = useHeyaServiceStore.getState().status
      if (
        !status?.enabled ||
        !status.configured ||
        !artist.trim() ||
        (kind === "album" && !title?.trim())
      )
        return null
      const key = keyFor(artist, title),
        requestKey = `${kind}:${key}`,
        field = kind === "artist" ? "artists" : "albums",
        loading = kind === "artist" ? "_loadingArtists" : "_loadingAlbums"
      const cached = get()[field][key]
      if (
        cached &&
        Date.now() - cached.cachedAt < TTL &&
        cached.revision === status.revision &&
        (cached.data === null ||
          (cached.data.revision === status.revision &&
            cached.data.artist?.trim().toLowerCase() ===
              artist.trim().toLowerCase() &&
            (kind === "artist" ||
              cached.data.title?.trim().toLowerCase() ===
                title?.trim().toLowerCase())))
      )
        return cached.data
      const existing = inflight.get(requestKey)
      if (existing) return existing
      if (pending >= 32) return null
      const version = epoch
      pending++
      set((s) => ({ [loading]: { ...s[loading], [key]: true } }))
      const current = () =>
        version === epoch &&
        inflight.get(requestKey) === request &&
        useHeyaServiceStore.getState().status?.revision === status.revision &&
        !!useHeyaServiceStore.getState().status?.enabled
      const request = (async () => {
        const match =
          kind === "artist"
            ? await useMusicBrainzMetadataStore
                .getState()
                .getArtist(artist)
                .catch(() => null)
            : await useMusicBrainzMetadataStore
                .getState()
                .getAlbum(artist, title!)
                .catch(() => null)
        const mbid =
          match &&
          (kind === "artist"
            ? "name" in match &&
              match.name.trim().toLowerCase() === artist.trim().toLowerCase()
            : albumMatches(match, artist, title!))
            ? match.mbid
            : null
        if (!current()) return null
        const result = await lookup({
          revision: status.revision,
          kind,
          artist,
          title: title ?? null,
          mbid,
        })
        if (!current()) return null
        let data: HeyaArtwork | null = null
        if (
          result.status === "ready" &&
          result.item.revision === status.revision &&
          result.item.artist.trim().toLowerCase() ===
            artist.trim().toLowerCase() &&
          (kind === "artist" ||
            result.item.title?.trim().toLowerCase() ===
              title?.trim().toLowerCase())
        ) {
          data = {
            ...result.item,
            posters: verifiedHeyaCandidates(
              Array.isArray(result.item.posters) ? result.item.posters : [],
              status.revision
            ),
            backgrounds: verifiedHeyaCandidates(
              Array.isArray(result.item.backgrounds)
                ? result.item.backgrounds
                : [],
              status.revision
            ),
          }
        }
        // Ambiguity is retryable; never turn it into a durable negative match.
        if (result.status !== "ambiguous")
          set((s) => ({
            [field]: bounded(s[field], key, {
              data,
              cachedAt: Date.now(),
              revision: status.revision,
            }),
          }))
        return data
      })()
        .catch(() => null)
        .finally(() => {
          pending--
          if (inflight.get(requestKey) !== request) return
          inflight.delete(requestKey)
          set((s) => ({
            [loading]: Object.fromEntries(
              Object.entries(s[loading]).filter(([old]) => old !== key)
            ),
          }))
        })
      inflight.set(requestKey, request)
      return request
    }
    return {
      artists: {},
      albums: {},
      _loadingArtists: {},
      _loadingAlbums: {},
      _hasHydrated: true,
      getArtist: (artist) => fetch("artist", artist),
      getAlbum: (artist, title) => fetch("album", artist, title),
      invalidateArtist: (artist) => invalidate("artist", keyFor(artist)),
      invalidateAlbum: (artist, title) =>
        invalidate("album", keyFor(artist, title)),
      clearCache: () => {
        epoch++
        inflight.clear()
        set({
          artists: {},
          albums: {},
          _loadingArtists: {},
          _loadingAlbums: {},
        })
      },
    }
  })
  return store
}
export const useHeyaArtworkStore = createHeyaArtworkStore()
useHeyaServiceStore.subscribe((next, old) => {
  if (next.status?.revision !== old.status?.revision)
    useHeyaArtworkStore.getState().clearCache()
})
