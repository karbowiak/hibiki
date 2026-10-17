import { normalizeLabel, recordingMbid } from "../playlistSync/matching"
import { samePlaylistIdentity } from "../playlistSync/types"
import type {
  FavoriteEntry,
  FavoriteRecording,
  FavoriteService,
  FavoriteState,
} from "./types"

export function emptyFavorites(): FavoriteState {
  return {
    version: 1,
    revision: 0,
    ratingModel: 1,
    settings: {
      plex: false,
      lastfm: false,
      listenbrainz: false,
      ratingThreshold: 6,
    },
    bindings: {},
    entries: {},
  }
}
function labels(row: FavoriteRecording) {
  return JSON.stringify([normalizeLabel(row.artist), normalizeLabel(row.title)])
}
export function lastfmFavoriteKey(row: FavoriteRecording) {
  return `lastfm:${JSON.stringify([row.artist.toLowerCase().trim(), row.title.toLowerCase().trim()])}`
}
export function favoriteLikedAt(item: FavoriteEntry): number | undefined {
  // Older explicit hearts already have the actual local edit time. Import times
  // on non-explicit entries are not evidence of when the song was loved.
  return item.likedAt ?? (item.explicit ? item.changedAt : undefined)
}
function earliestLike(first?: number | null, second?: number | null) {
  return first && second
    ? Math.min(first, second)
    : first || second || undefined
}
/** Index compact identities once for bulk imports, rather than scanning N rows per recording. */
function favoriteIndex(entries: FavoriteState["entries"]) {
  const strong = new Map<string, FavoriteEntry>(),
    byLabels = new Map<string, Map<string, FavoriteEntry>>()
  const add = (item: FavoriteEntry) => {
    strong.set(item.id, item)
    for (const id of item.localTrackIds) strong.set(`local:${id}`, item)
    if (item.recordingMbid) strong.set(`mbid:${item.recordingMbid}`, item)
    if (item.recordingMsid) strong.set(`msid:${item.recordingMsid}`, item)
    for (const source of Object.values(item.sources))
      if (source) strong.set(source.key, item)
    if (item.artist && item.title) {
      const key = labels(item),
        group = byLabels.get(key) ?? new Map<string, FavoriteEntry>()
      group.set(item.id, item)
      byLabels.set(key, group)
    }
  }
  Object.values(entries).forEach(add)
  const find = (row: FavoriteRecording) => {
    const exact =
      strong.get(row.key) ??
      (row.localTrackId
        ? strong.get(`local:${row.localTrackId}`)
        : undefined) ??
      (recordingMbid(row.recordingMbid)
        ? strong.get(`mbid:${recordingMbid(row.recordingMbid)}`)
        : undefined) ??
      (recordingMbid(row.recordingMsid)
        ? strong.get(`msid:${recordingMbid(row.recordingMsid)}`)
        : undefined)
    if (exact) return entries[exact.id] ?? exact
    if (!row.title || !row.artist) return
    const matches = [...(byLabels.get(labels(row))?.values() ?? [])].filter(
      (item) =>
        (!row.durationMs ||
          !item.durationMs ||
          Math.abs(row.durationMs - item.durationMs) < 4000) &&
        !(
          item.recordingMbid &&
          row.recordingMbid &&
          item.recordingMbid !== row.recordingMbid
        ) &&
        !(
          item.recordingMsid &&
          row.recordingMsid &&
          item.recordingMsid !== row.recordingMsid &&
          !(item.recordingMbid && item.recordingMbid === row.recordingMbid)
        )
    )
    return matches.length === 1
      ? (entries[matches[0].id] ?? matches[0])
      : undefined
  }
  return { add, find }
}
export function findFavorite(
  state: FavoriteState,
  row: FavoriteRecording
): FavoriteEntry | undefined {
  return favoriteIndex(state.entries).find(row)
}
function entry(
  row: FavoriteRecording,
  liked: boolean,
  explicit: boolean
): FavoriteEntry {
  return {
    ...row,
    id: row.key,
    liked,
    explicit,
    localTrackIds: row.localTrackId ? [row.localTrackId] : [],
    sources: {},
    changedAt: Date.now(),
  }
}
export function setFavorite(
  state: FavoriteState,
  row: FavoriteRecording,
  liked: boolean,
  explicit = true
): FavoriteState {
  const linked = row.localTrackId
    ? Object.values(state.entries).filter((item) =>
        item.localTrackIds.includes(row.localTrackId!)
      )
    : []
  const found = findFavorite(state, row)
  const targets = linked.length ? linked : [found]
  const entries = { ...state.entries }
  let changed = false
  for (const previous of targets) {
    if (previous?.explicit && !explicit) continue
    const next = {
      ...(previous ?? entry(row, liked, explicit)),
      title: row.title || previous?.title || "Unknown recording",
      artist: row.artist || previous?.artist || "Unknown artist",
      album: row.album || previous?.album,
      durationMs: row.durationMs || previous?.durationMs,
      likedAt: liked
        ? previous?.liked
          ? (favoriteLikedAt(previous) ?? row.likedAt ?? Date.now())
          : explicit
            ? Date.now()
            : (row.likedAt ?? Date.now())
        : previous?.likedAt,
      liked,
      explicit,
      localTrackIds: [
        ...new Set([
          ...(previous?.localTrackIds ?? []),
          ...(row.localTrackId ? [row.localTrackId] : []),
        ]),
      ].slice(0, 16),
      changedAt: Date.now(),
    }
    entries[next.id] = next
    changed = true
  }
  return changed ? { ...state, entries } : state
}
export function seedFavoriteRatings(
  state: FavoriteState,
  rows: FavoriteRecording[]
): FavoriteState {
  const entries = { ...state.entries },
    index = favoriteIndex(entries)
  for (const row of rows) {
    const previous = index.find(row)
    if (previous?.explicit) continue
    const next = {
      ...(previous ?? entry(row, true, false)),
      liked: true,
      likedAt: previous
        ? (favoriteLikedAt(previous) ?? row.likedAt)
        : row.likedAt,
      localTrackIds: [
        ...new Set([
          ...(previous?.localTrackIds ?? []),
          ...(row.localTrackId ? [row.localTrackId] : []),
        ]),
      ].slice(0, 16),
    }
    entries[next.id] = next
    index.add(next)
  }
  return { ...state, entries, ratingsImported: true }
}
/** A complete roster is required for removals; first connection is an additive merge. */
export function mergeFavoriteSnapshot(
  state: FavoriteState,
  service: FavoriteService,
  rows: FavoriteRecording[],
  complete: boolean
): FavoriteState {
  const binding = state.bindings[service]
  if (!binding || !state.settings[service]) return state
  const entries = { ...state.entries },
    seen = new Set<string>()
  const working = { ...state, entries },
    index = favoriteIndex(entries)
  const save = (next: FavoriteEntry, previous?: FavoriteEntry) => {
    if (previous && JSON.stringify(next) === JSON.stringify(previous)) return
    entries[next.id] = next
    index.add(next)
  }
  for (const row of rows) {
    if (!row.key || seen.has(row.key))
      throw Error("Repeated favorite page or identity")
    seen.add(row.key)
    const previous = index.find(row)
    const before = previous?.sources[service]
    const desired = previous?.liked ?? true
    const previousDesired = before?.desired ?? before?.liked ?? desired
    const incoming = !binding.initialized
      ? !(previous?.explicit && !desired)
      : !previous
        ? true
        : before && !before.liked && desired === previousDesired
          ? true
          : desired
    const next: FavoriteEntry = {
      ...(previous ?? entry(row, true, false)),
      title:
        previous?.title && previous.title !== "Unknown recording"
          ? previous.title
          : row.title,
      artist:
        previous?.artist && previous.artist !== "Unknown artist"
          ? previous.artist
          : row.artist,
      album: previous?.album || row.album,
      durationMs: previous?.durationMs || row.durationMs,
      likedAt: incoming
        ? previous?.liked
          ? previous.explicit
            ? favoriteLikedAt(previous)
            : earliestLike(favoriteLikedAt(previous), row.likedAt)
          : (row.likedAt ?? undefined)
        : previous?.likedAt,
      recordingMbid:
        previous?.recordingMbid || recordingMbid(row.recordingMbid),
      recordingMsid: previous?.recordingMsid || row.recordingMsid,
      localTrackIds: [
        ...new Set([
          ...(previous?.localTrackIds ?? []),
          ...(row.localTrackId ? [row.localTrackId] : []),
        ]),
      ].slice(0, 16),
      liked: incoming,
      sources: {
        ...previous?.sources,
        [service]: {
          key: row.key,
          liked: true,
          desired: incoming === true ? incoming : previousDesired,
          likedAt: row.likedAt ?? (before?.liked ? before.likedAt : undefined),
        },
      },
    }
    save(next, previous)
  }
  if (complete)
    for (const item of Object.values(entries)) {
      const prior = item.sources[service]
      if (prior && !seen.has(prior.key)) {
        const liked =
          binding.initialized &&
          prior.liked &&
          item.liked === (prior.desired ?? prior.liked)
            ? false
            : item.liked
        save(
          {
            ...item,
            liked,
            sources: {
              ...item.sources,
              [service]: {
                ...prior,
                liked: false,
                desired: liked ? (prior.desired ?? item.liked) : false,
              },
            },
          },
          item
        )
      } else if (!prior) {
        const key =
          service === "plex"
            ? item.localTrackIds[0]
              ? `local:${item.localTrackIds[0]}`
              : undefined
            : service === "lastfm"
              ? item.title && item.artist
                ? lastfmFavoriteKey(item)
                : undefined
              : item.recordingMbid
                ? `mbid:${item.recordingMbid}`
                : item.recordingMsid
                  ? `msid:${item.recordingMsid}`
                  : undefined
        if (key)
          save(
            {
              ...item,
              sources: {
                ...item.sources,
                [service]: { key, liked: false, desired: item.liked },
              },
            },
            item
          )
      }
    }
  return {
    ...working,
    bindings: {
      ...state.bindings,
      [service]: { ...binding, initialized: binding.initialized || complete },
    },
  }
}
export function bindFavorites(
  state: FavoriteState,
  service: FavoriteService,
  account: import("../playlistSync/types").PlaylistAccount
): FavoriteState {
  const old = state.bindings[service]
  if (old && !samePlaylistIdentity(old.account, account))
    throw Error(
      `Reconnect the original ${service} account before syncing favorites`
    )
  return {
    ...state,
    bindings: {
      ...state.bindings,
      [service]: old ? { ...old, account } : { account, initialized: false },
    },
  }
}
export function acknowledgeFavorite(
  state: FavoriteState,
  service: FavoriteService,
  id: string,
  liked: boolean,
  key: string
): FavoriteState {
  const previous = state.entries[id]
  if (!previous) throw Error("Favorite no longer exists")
  return {
    ...state,
    entries: {
      ...state.entries,
      [id]: {
        ...previous,
        sources: {
          ...previous.sources,
          [service]: {
            key,
            liked,
            desired: liked,
            likedAt:
              liked && previous.sources[service]?.liked
                ? previous.sources[service]?.likedAt
                : undefined,
          },
        },
      },
    },
  }
}
export async function favoritePlaylistHash(
  title: string,
  ids: string[]
): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([title, ids]))
      )
    ),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}
