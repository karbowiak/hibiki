import { invoke } from "@tauri-apps/api/core"
import { useEffect, useRef, useState } from "react"
import { captureMusicOwner } from "../mixedPlaylists/counterparts"
import { captureDownloadOwner } from "./downloadStatusStore"
import { useProviderStore } from "../stores/providerStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import type { MusicPlaylist, MusicTrack } from "../types/music"
import type { PagedTrackSource } from "../lib/pagedPlayback"
import type { DownloadIssue, EntityDownloadStatus } from "./downloadEntities"

export interface DownloadedPlaylist {
  metadata: MusicPlaylist & { tracks: MusicTrack[] }
  status: EntityDownloadStatus
  issues: DownloadIssue[]
}
/** Drain only an explicitly requested playlist, retaining occurrence order. */
export async function playlistDownloadTracks(
  source: PagedTrackSource,
  current: () => boolean
): Promise<MusicTrack[]> {
  const tracks: MusicTrack[] = []
  for (;;) {
    if (!current()) throw Error("Download selection changed.")
    const page = await source.loadPage(tracks.length, 100)
    if (!current()) throw Error("Download selection changed.")
    if (
      (page.offset !== undefined && page.offset !== tracks.length) ||
      page.items.length > 100
    )
      throw Error(
        "The playlist returned an unexpected page. Refresh and try again."
      )
    tracks.push(...page.items)
    if (tracks.length > 10000)
      throw Error("Download playlists with at most 10,000 songs.")
    if (tracks.length >= page.total) return tracks
    if (!page.items.length)
      throw Error(
        "The complete playlist could not be loaded. Refresh and retry."
      )
  }
}
export function usePlaylistDownloads(id: string, usesPlex: boolean) {
  const provider = useProviderStore((state) => state.provider)
  const youtubeRevision = useYoutubeMusicDiscoveryStore(
    (state) => state.revision
  )
  const generation = useRef(0),
    active = useRef(false)
  const [saved, setSaved] = useState<DownloadedPlaylist | null>(null)
  const [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const request = ++generation.current,
      owner = captureMusicOwner()
    const context = usesPlex ? captureDownloadOwner()?.context : null
    let alive = true,
      reading = false
    const current = () =>
      alive && generation.current === request && owner.current()
    setSaved(null)
    setLoaded(false)
    setError(null)
    setBusy(false)
    active.current = false
    const read = async () => {
      if (reading || !current() || (usesPlex && !context)) {
        if (current()) setLoaded(true)
        return
      }
      reading = true
      try {
        const value = await invoke<DownloadedPlaylist | null>(
          "playlist_download_read",
          { id, context }
        )
        if (current())
          setSaved((previous) =>
            value &&
            previous &&
            previous.status.failed === value.status.failed &&
            JSON.stringify(previous.issues.slice(0, 50)) ===
              JSON.stringify(value.issues)
              ? { ...value, issues: previous.issues }
              : value
          )
      } catch {
        /* Missing/corrupt snapshots never prevent the connected page. */
      } finally {
        reading = false
        if (current()) setLoaded(true)
      }
    }
    void read()
    const timer = setInterval(() => void read(), 2500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [id, usesPlex, provider, provider?.playbackSession, youtubeRevision])
  const download = async (
    metadata: MusicPlaylist,
    load: (current: () => boolean) => Promise<MusicTrack[]>
  ) => {
    if (active.current) return
    const request = generation.current,
      owner = captureMusicOwner()
    const current = () => request === generation.current && owner.current()
    const context = usesPlex ? captureDownloadOwner()?.context : null
    active.current = true
    setBusy(true)
    setError(null)
    try {
      if (usesPlex && !context)
        throw Error(
          "Connect this playlist's original Plex library to download it."
        )
      const tracks = await load(current)
      if (!current()) return
      const value = await invoke<DownloadedPlaylist>("playlist_download_save", {
        id,
        context,
        metadata,
        tracks,
      })
      if (current()) setSaved(value)
    } catch (failure) {
      if (current())
        setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (current()) {
        active.current = false
        setBusy(false)
      }
    }
  }
  const remove = async () => {
    const request = generation.current,
      owner = captureMusicOwner()
    try {
      await invoke("playlist_download_remove", {
        id,
        context: usesPlex ? captureDownloadOwner()?.context : null,
      })
      if (generation.current === request && owner.current()) setSaved(null)
    } catch (failure) {
      if (generation.current === request && owner.current())
        setError(String(failure))
    }
  }
  const loadIssues = async () => {
    if (!saved || busy) return
    const request = generation.current,
      owner = captureMusicOwner(),
      offset = saved.issues.length
    setBusy(true)
    try {
      const page = await invoke<{ items: DownloadIssue[]; total: number }>(
        "playlist_download_issues",
        {
          id,
          offset,
          context: usesPlex ? captureDownloadOwner()?.context : null,
        }
      )
      if (generation.current === request && owner.current())
        setSaved((previous) =>
          previous
            ? {
                ...previous,
                issues: [...previous.issues.slice(0, offset), ...page.items],
              }
            : previous
        )
    } catch (failure) {
      if (generation.current === request && owner.current())
        setError(String(failure))
    } finally {
      if (generation.current === request && owner.current()) setBusy(false)
    }
  }
  return { saved, loaded, busy, error, download, remove, loadIssues }
}
