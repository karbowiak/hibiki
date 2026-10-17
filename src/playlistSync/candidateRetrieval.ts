import type { MusicProvider } from "../providers/types"
import type { MusicTrack } from "../types/music"
import { matchTrack, playlistSearchTitle, recordingMbid } from "./matching"
import { playlistTrackFromMusic } from "./provider"
import type { PlaylistTrack } from "./types"

export function candidateQueryKey(track: PlaylistTrack): string {
  return JSON.stringify([
    track.artist,
    track.title,
    recordingMbid(track.recordingMbid),
  ])
}
/** Discovery cannot confer identity: GUIDs and raw metadata remain unverified. */
export async function retrievePlaylistCandidates(
  provider: MusicProvider,
  source: PlaylistTrack,
  current: () => boolean,
  onLimited?: (reason: "truncated" | "unavailable") => void
): Promise<PlaylistTrack[]> {
  const scope = provider.cacheScope,
    session = provider.playbackSession
  const owns = () => {
    if (
      !current() ||
      provider.cacheScope !== scope ||
      provider.playbackSession !== session
    )
      throw Error("Candidate retrieval owner changed")
  }
  owns()
  const merged = new Map<string, PlaylistTrack>()
  let usable = false
  async function collect(
    request: () => Promise<MusicTrack[]>,
    limit: number,
    onFailure?: () => void
  ) {
    owns()
    try {
      const rows = await request()
      owns()
      if (rows.length > limit)
        throw Error("Candidate response exceeded its budget")
      const parsed = rows.map((row) => playlistTrackFromMusic(row))
      if (parsed.some((row) => !row.id || !row.title || !row.artist))
        throw Error("Candidate metadata was incomplete")
      for (const row of parsed) {
        const existing = merged.get(row.id)
        if (existing && JSON.stringify(existing) !== JSON.stringify(row))
          throw Error("Candidate changed during retrieval")
      }
      for (const row of parsed) merged.set(row.id, row)
      usable = true
    } catch {
      owns()
      onFailure?.()
    }
  }
  const title = playlistSearchTitle(source)
  const query = `${source.artist} ${title}`.trim()
  if (!source.title.trim() || !source.artist.trim() || query.length > 1000)
    throw Error("Source labels need manual search")
  const broad = async (query: string) =>
    (await provider.search(query, "track")).filter(
      (row): row is MusicTrack & { type: "track" } => row.type === "track"
    )
  await collect(() => broad(query), 50)
  if (matchTrack(source, [...merged.values()]).status !== "matched") {
    if (title !== query) await collect(() => broad(title), 50)
    if (
      provider.findPlaylistCandidates &&
      matchTrack(source, [...merged.values()]).status !== "matched"
    ) {
      let issue: "truncated" | "unavailable" | undefined
      await collect(
        async () => {
          const result = await provider.findPlaylistCandidates!({
            id: source.id,
            title,
            artist: source.artist,
            album: source.album,
            durationMs: source.durationMs,
            recordingMbid: recordingMbid(source.recordingMbid),
          })
          owns()
          // A limited catalogue cannot establish that a competing edition is absent.
          if (result.truncated || result.unavailable) {
            issue = result.truncated ? "truncated" : "unavailable"
            throw Error("Scoped discovery needs manual review")
          }
          return result.tracks
        },
        200,
        () => {
          issue ??= "unavailable"
        }
      )
      if (issue) onLimited?.(issue)
    }
  }
  owns()
  if (!usable) throw Error("Search lookup unavailable")
  return [...merged.values()].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true })
  )
}
