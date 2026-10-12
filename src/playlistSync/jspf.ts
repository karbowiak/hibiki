import { recordingMbid } from "./matching"
import { MAX_PLAYLIST_ITEMS, validateSnapshot } from "./planner"
import type { PlaylistAccount, PlaylistSnapshot, PlaylistTrack } from "./types"
export const PLAYLIST_EXTENSION = "https://musicbrainz.org/doc/jspf#playlist"
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid playlist response")
  return value as Record<string, any>
}
function text(value: unknown, max = 1000) {
  if (value == null) return ""
  if (typeof value !== "string" || value.length > max)
    throw Error("Invalid playlist text")
  return value
}
export function mbidFromRecordingIdentifier(value: unknown): string | null {
  const values = Array.isArray(value) ? value : [value]
  if (values.length > 20) throw Error("Too many track identifiers")
  const mbids = new Set<string>()
  for (const identifier of values) {
    if (typeof identifier !== "string" || identifier.length > 500) continue
    const match =
      /^https?:\/\/musicbrainz\.org\/recording\/([0-9a-f-]+)$/i.exec(identifier)
    const mbid = match && recordingMbid(match[1])
    if (mbid) mbids.add(mbid)
  }
  if (mbids.size > 1) throw Error("Conflicting recording identifiers")
  return [...mbids][0] ?? null
}
export function playlistId(value: unknown): string {
  const id =
    typeof value === "string"
      ? value.replace(/^https:\/\/listenbrainz\.org\/playlist\//, "")
      : ""
  const canonical = recordingMbid(id)
  if (!canonical) throw Error("Invalid ListenBrainz playlist identifier")
  return canonical
}
export function fromJspf(
  value: unknown,
  account: PlaylistAccount
): PlaylistSnapshot {
  const playlist = object(object(value).playlist)
  const id = playlistId(playlist.identifier)
  const tracks = playlist.track ?? []
  if (!Array.isArray(tracks) || tracks.length > MAX_PLAYLIST_ITEMS)
    throw Error("Playlist exceeds the supported track limit")
  const snapshot: PlaylistSnapshot = {
    account,
    id,
    title: text(playlist.title, 500),
    items: tracks.map((raw, index) => {
      const track = object(raw),
        mbid = mbidFromRecordingIdentifier(track.identifier)
      const duration = track.duration
      if (
        duration != null &&
        (!Number.isFinite(duration) || duration < 0 || duration > 86400000)
      )
        throw Error("Invalid playlist duration")
      return {
        occurrenceId: `${id}:${index}`,
        track: {
          id: mbid ?? `${id}:${index}`,
          recordingMbid: mbid,
          title: text(track.title),
          artist: text(track.creator),
          album: text(track.album),
          durationMs: duration ?? null,
        },
      }
    }),
  }
  validateSnapshot(snapshot)
  return snapshot
}
/** Writes only canonical recording identities. The server owns all returned descriptive metadata. */
export function toJspf(title: string, tracks: readonly PlaylistTrack[]) {
  if (!title.trim() || title.length > 500 || tracks.length > MAX_PLAYLIST_ITEMS)
    throw Error("Invalid or oversized playlist")
  return {
    playlist: {
      title: title.trim(),
      extension: { [PLAYLIST_EXTENSION]: { public: false } },
      track: tracks.map((track) => {
        const mbid = recordingMbid(track.recordingMbid)
        if (!mbid)
          throw Error("Each exported occurrence needs a recording MBID")
        return { identifier: [`https://musicbrainz.org/recording/${mbid}`] }
      }),
    },
  }
}
