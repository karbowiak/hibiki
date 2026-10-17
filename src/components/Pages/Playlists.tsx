import { useState } from "react"
import { PlaylistSyncDialog } from "../PlaylistSync/PlaylistSyncDialog"
import { MediaCard } from "../MediaCard"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore } from "../../stores"
import { usePlayerStore } from "../../stores/playerStore"
import { useContextMenu } from "../../hooks/useContextMenu"
import { MediaGrid } from "../shared/MediaGrid"

export function Playlists() {
  const [showSync, setShowSync] = useState(false)
  const playlists = useLibraryStore((s) => s.playlists)
  const playPlaylist = usePlayerStore(useShallow((s) => s.playPlaylist))
  const { handler: ctxMenu } = useContextMenu()

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
            {playlists.map((pl) => {
              const href = `/playlist/${pl.id}`
              return (
                <MediaCard
                  key={pl.id}
                  href={href}
                  title={pl.title}
                  desc={`${pl.trackCount.toLocaleString()} ${pl.trackCount === 1 ? "song" : "songs"}`}
                  thumb={pl.thumbUrl}
                  onContextMenu={ctxMenu("playlist", pl)}
                  onPlay={() =>
                    void playPlaylist(pl.id, pl.trackCount, pl.title, href)
                  }
                />
              )
            })}
          </MediaGrid>
        )}
      </div>
    </div>
  )
}
