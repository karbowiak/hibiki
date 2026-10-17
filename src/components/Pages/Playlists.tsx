import { useState } from "react"
import { PlaylistSyncDialog } from "../PlaylistSync/PlaylistSyncDialog"
import { MediaGrid } from "../shared/MediaGrid"
import { useLibraryPlaylists } from "../../hooks/useLibraryPlaylists"
import { LibraryPlaylistCard } from "../shared/LibraryPlaylistCard"
import { DiscoveryMore } from "../shared/DiscoveryMore"

export function Playlists() {
  const [showSync, setShowSync] = useState(false)
  const { playlists, youtube } = useLibraryPlaylists()

  const count = playlists.length

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="collection-header">
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-3">
          <div>
            <h1 className="discovery-title">
              Playlists
            </h1>
            <p className="mt-2 max-w-xl select-text text-sm text-(--text-secondary)">
              All your playlists in one place.
            </p>
          </div>
          <p className="text-sm text-(--text-secondary)">
            {count.toLocaleString()} {count === 1 ? "playlist" : "playlists"}
          </p>
        </div>
        <button
          type="button"
          className="media-secondary"
          onClick={() => setShowSync(true)}
        >
          Sync
        </button>
      </div>
      {showSync && <PlaylistSyncDialog onClose={() => setShowSync(false)} />}
      {/* Playlist grid */}
      <div className="px-8 pt-2">
        {count === 0 ? (
          <div className="py-12 text-center text-sm text-(--text-muted)">
            No playlists yet. Create one to get started.
          </div>
        ) : (
          <MediaGrid>
            {playlists.map(playlist => <LibraryPlaylistCard key={playlist.id} playlist={playlist} />)}
          </MediaGrid>
        )}
        {youtube.connected && <DiscoveryMore more={youtube.more} loading={youtube.loading} error={youtube.error} load={() => void (youtube.error ? youtube.retry() : youtube.loadMore())} />}
      </div>
    </div>
  )
}
