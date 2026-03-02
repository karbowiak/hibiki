import { useLibraryStore, useConnectionStore, buildPlexImageUrl } from "../../stores"
import { MediaCard } from "../MediaCard"

export function Library() {
  const playlists = useLibraryStore(s => s.playlists)
  const { baseUrl, token } = useConnectionStore()

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Your Library</h1>
      {playlists.length === 0 ? (
        <div className="text-sm text-gray-400">No playlists found.</div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(var(--card-size, 160px), 1fr))" }}>
          {playlists.map(pl => {
            const artPath = pl.thumb ?? pl.composite
            const thumbUrl = artPath ? buildPlexImageUrl(baseUrl, token, artPath) : null
            return (
              <MediaCard
                key={pl.rating_key}
                title={pl.title}
                desc={`Playlist · ${pl.leaf_count} songs`}
                thumb={thumbUrl}
                href={`/playlist/${pl.rating_key}`}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
