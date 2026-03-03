import { useEffect, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useConnectionStore, usePlayerStore, buildPlexImageUrl } from "../../stores"
import { getItemsByTag, buildTagFilterUri } from "../../lib/plex"
import { prefetchAlbum } from "../../stores/metadataCache"
import { MediaCard } from "../MediaCard"
import type { Album, PlexMedia } from "../../types/plex"

type TagType = "genre" | "mood" | "style"

export function TagPage({ tagType, tagName }: { tagType: TagType; tagName: string }) {
  const { baseUrl, token, musicSectionId, sectionUuid } = useConnectionStore()
  const { playFromUri } = usePlayerStore(useShallow(s => ({ playFromUri: s.playFromUri })))

  const [albums, setAlbums] = useState<Album[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!musicSectionId) return
    setIsLoading(true)
    setError(null)
    setAlbums([])
    getItemsByTag(musicSectionId, tagType, tagName, "9")
      .then(items => {
        setAlbums(items.filter((m): m is Album & { type: "album" } => m.type === "album"))
      })
      .catch(e => setError(String(e)))
      .finally(() => setIsLoading(false))
  }, [musicSectionId, tagType, tagName])

  function handlePlayAll() {
    if (!sectionUuid || !musicSectionId) return
    const uri = buildTagFilterUri(sectionUuid, musicSectionId, tagType, tagName)
    void playFromUri(uri, true, tagName, null)
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center gap-4">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-widest text-gray-400">
            {tagType}
          </div>
          <h1 className="text-3xl font-bold">{tagName}</h1>
        </div>
        {albums.length > 0 && sectionUuid && (
          <button
            onClick={handlePlayAll}
            title={`Shuffle all ${tagName} tracks`}
            className="flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-4 py-1.5 text-sm font-semibold text-accent transition-all hover:border-accent hover:bg-accent/20 active:scale-95"
          >
            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
              <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
              <path d="m7.5 10.723.98-1.167.957 1.14a2.25 2.25 0 0 0 1.724.804h1.947l-1.017-1.018a.75.75 0 1 1 1.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 1 1-1.06-1.06L13.109 13H11.16a3.75 3.75 0 0 1-2.873-1.34l-.787-.938z" />
            </svg>
            Shuffle all
          </button>
        )}
      </div>

      {isLoading && <div className="text-sm text-gray-400">Loading…</div>}
      {error && <div className="text-sm text-red-400">{error}</div>}
      {!isLoading && !error && albums.length === 0 && (
        <div className="text-sm text-gray-400">No albums found for "{tagName}".</div>
      )}

      {albums.length > 0 && (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(var(--card-size, 160px), 1fr))" }}
        >
          {albums.map(album => (
            <MediaCard
              key={album.rating_key}
              title={album.title}
              desc={album.parent_title}
              thumb={album.thumb ? buildPlexImageUrl(baseUrl, token, album.thumb) : null}
              href={`/album/${album.rating_key}`}
              prefetch={() => prefetchAlbum(album.rating_key)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
