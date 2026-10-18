import { Button } from "../shared/Button"
import { useEffect, useRef, useState } from "react"
import { Link } from "wouter"
import { useProviderStore } from "../../stores/providerStore"
import type { MusicAlbum, MusicTrack } from "../../types/music"
export function VersionReviewPanel({
  album,
  tracks: supplied,
}: {
  album: MusicAlbum
  tracks?: MusicTrack[]
}) {
  const provider = useProviderStore((state) => state.provider)
  const scope = provider?.cacheScope
  const session = provider?.playbackSession
  const origin = useRef({ provider, scope, session })
  const ownsOrigin =
    origin.current.provider === provider &&
    origin.current.scope === scope &&
    origin.current.session === session
  const [versions, setVersions] = useState<MusicAlbum[]>([album])
  const [tracks, setTracks] = useState<MusicTrack[]>(supplied ?? [])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)
  const allIds = [...new Set([album.id, ...(album._alternateIds ?? [])])]
  const identity = JSON.stringify(allIds)
  useEffect(() => {
    const owner = ++generation.current
    let disposed = false
    const current = () =>
      !disposed &&
      owner === generation.current &&
      useProviderStore.getState().provider === provider &&
      provider?.cacheScope === scope &&
      provider?.playbackSession === session
    if (!ownsOrigin) {
      setVersions([])
      setTracks([])
      setLoading(false)
      return () => {
        disposed = true
      }
    }
    setVersions([album])
    setTracks(supplied ?? [])
    setFailed(false)
    if (!provider) {
      setLoading(false)
      setFailed(true)
      return () => {
        disposed = true
      }
    }
    setLoading(true)
    const ids = allIds.slice(0, 16).filter((id) => id !== album.id)
    let next = 0
    let failures = false
    const loaded: MusicAlbum[] = []
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++]
        if (!current()) return
        try {
          const item = await provider.getAlbum(id)
          if (current()) {
            if (item.id === id) loaded.push(item)
            else failures = true
          }
        } catch {
          if (current()) failures = true
        }
      }
    }
    const getTracks = supplied
      ? Promise.resolve(supplied)
      : provider.getAlbumTracks(album.id).catch(() => {
          if (current()) failures = true
          return []
        })
    void Promise.all([
      Promise.all(
        Array.from({ length: Math.min(3, ids.length) }, () => worker())
      ),
      getTracks,
    ]).then(([, items]) => {
      if (!current()) return
      const byId = new Map(loaded.map((item) => [item.id, item]))
      setVersions([
        album,
        ...ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
      ])
      setTracks(items)
      setFailed(failures)
      setLoading(false)
    })
    return () => {
      disposed = true
    }
  }, [
    provider,
    ownsOrigin,
    scope,
    session,
    album.id,
    album.title,
    album.artistName,
    album.year,
    album.trackCount,
    identity,
    supplied,
    attempt,
  ])
  if (!ownsOrigin)
    return (
      <p role="status" className="text-sm text-(--text-secondary)">
        The library changed. Close this review and reopen versions from the
        current library.
      </p>
    )
  return (
    <section
      aria-labelledby="version-review-title"
      className="space-y-5 text-(--text-primary)"
    >
      <header>
        <h2 id="version-review-title" className="text-lg font-semibold">
          Album copies
        </h2>
        <p className="mt-2 text-sm text-(--text-secondary)">
          Compare the copies Plex already knows about. Opening an album below
          does not merge, delete or move any files.
        </p>
      </header>
      {loading && (
        <p role="status" className="text-sm text-(--text-secondary)">
          Loading saved album and media details…
        </p>
      )}
      {failed && (
        <div
          role="status"
          className="rounded-lg border border-(--border) p-3 text-sm"
        >
          <p>
            Some versions could not be loaded. Saved details remain available;
            reconnect to Plex for uncached versions.
          </p>
          <Button
            variant="secondary"
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
            className="mt-2 rounded-lg border border-(--border) px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Retry version details
          </Button>
        </div>
      )}
      <ul aria-label="Album copies" className="space-y-2">
        {versions.map((version) => (
          <li
            key={version.id}
            className="rounded-lg border border-(--border) p-3"
          >
            <Link
              href={`/album/${encodeURIComponent(version.id)}`}
              className="font-medium hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {version.title}
            </Link>
            <p className="mt-1 text-sm text-(--text-secondary)">
              {version.artistName} · {version.year || "Year unknown"} ·{" "}
              {version.trackCount} {version.trackCount === 1 ? "track" : "tracks"} · Library item {version.id}
              {version.id === album.id ? " · Current overview copy" : ""}
            </p>
          </li>
        ))}
      </ul>
      {allIds.length > 16 && (
        <p className="text-sm text-(--text-secondary)">
          Showing the first 16 album copies in this review.
        </p>
      )}
      <div className="space-y-3">
        <h3 className="font-medium">Track media</h3>
        <p className="text-sm text-(--text-secondary)">
          Automatic playback selects its preferred playable quality. This review
          leaves that choice unchanged.
        </p>
        {tracks.length === 0 && !loading && (
          <p className="text-sm text-(--text-secondary)">
            No track media details have been loaded for this album yet.
          </p>
        )}
        {tracks.slice(0, 200).map((track, trackIndex) => (
          <article
            key={`${track.id}:${track.playlistItemId ?? ""}:${trackIndex}`}
            className="rounded-lg border border-(--border) p-3"
          >
            <h4 className="font-medium">{track.title}</h4>
            {track.mediaInfo?.versions?.length ? (
              <ul
                aria-label={`Media versions of ${track.title}`}
                className="mt-2 space-y-2"
              >
                {track.mediaInfo.versions.map((version, index) => (
                  <li
                    key={`${version.mediaId}:${index}`}
                    className="text-sm text-(--text-secondary)"
                  >
                    Version {version.versionNumber} ·{" "}
                    {version.codec?.toUpperCase() ?? "Codec unknown"}
                    {version.bitDepth ? ` · ${version.bitDepth}-bit` : ""}
                    {version.samplingRate
                      ? ` · ${(version.samplingRate / 1000).toFixed(1)} kHz`
                      : ""}
                    {version.bitrate ? ` · ${version.bitrate} kbps` : ""}
                    {version.fileSize !== null
                      ? ` · ${(version.fileSize / 1048576).toFixed(1)} MiB`
                      : ""}
                    {version.selected ? " · Automatic choice" : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-(--text-secondary)">
                Version details are unavailable in this cached response.
              </p>
            )}
            {track.mediaInfo?.versionsTruncated && (
              <p className="mt-2 text-xs text-(--text-secondary)">
                Up to 32 versions are shown, including the automatic playback
                choice.
              </p>
            )}
          </article>
        ))}
        {tracks.length > 200 && (
          <p className="text-sm text-(--text-secondary)">
            Showing the first 200 tracks; album files remain untouched.
          </p>
        )}
      </div>
    </section>
  )
}
