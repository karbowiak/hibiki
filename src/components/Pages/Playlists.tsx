import { useState } from "react"
import { PlaylistCopyDialog } from "../PlaylistSync/PlaylistCopyDialog"
import { PlaylistCopyReceipts } from "../PlaylistSync/PlaylistCopyReceipts"
import { MediaCard } from "../MediaCard"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore } from "../../stores"
import { usePlayerStore } from "../../stores/playerStore"
import { useContextMenu } from "../../hooks/useContextMenu"
import { MediaGrid } from "../shared/MediaGrid"

export function Playlists() {
  const [copyView, setCopyView] = useState<"import" | "receipts" | null>(null)
  const playlists = useLibraryStore(s => s.playlists)
  const playPlaylist = usePlayerStore(useShallow(s => s.playPlaylist))
  const { handler: ctxMenu } = useContextMenu()

  const count = playlists.length

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-5 px-8 py-6">
        <div className="flex h-32 w-32 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-700 to-purple-500 shadow-lg">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="56" height="56" fill="white">
            <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
          </svg>
        </div>

        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-3">
          <div>
            <h1 className="break-words text-[clamp(1.75rem,3.2vw,3rem)] font-bold leading-tight tracking-tight">
              Playlists
            </h1>
            <p className="mt-2 max-w-xl select-text text-sm text-[var(--text-secondary)]">
              All your playlists in one place.
            </p>
          </div>
          <p className="text-sm text-[var(--text-secondary)]">
            {count.toLocaleString()} {count === 1 ? "playlist" : "playlists"}
          </p>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap gap-2 px-8">
        <button type="button" className="media-secondary" onClick={() => setCopyView("import")}>Import a copy from ListenBrainz</button>
        <button type="button" className="media-secondary" onClick={() => setCopyView("receipts")}>Review copies</button>
      </div>
      {copyView === "import" && <PlaylistCopyDialog mode="import" onClose={() => setCopyView(null)} onCreated={() => useLibraryStore.getState().fetchPlaylists({ force: true })}/>}
      {copyView === "receipts" && <PlaylistCopyReceipts onClose={() => setCopyView(null)}/>}
      {/* Playlist grid */}
      <div className="px-8 pt-2">
        {count === 0 ? (
          <div className="py-12 text-center text-sm text-[var(--text-muted)]">
            No playlists yet. Create one to get started.
          </div>
        ) : (
          <MediaGrid>
            {playlists.map(pl => {
              const href = `/playlist/${pl.id}`
              return (
                <MediaCard
                  key={pl.id}
                  href={href}
                  title={pl.title}
                  desc={`${pl.trackCount.toLocaleString()} ${pl.trackCount === 1 ? "song" : "songs"}`}
                  thumb={pl.thumbUrl}
                  onContextMenu={ctxMenu("playlist", pl)}
                  onPlay={() => void playPlaylist(pl.id, pl.trackCount, pl.title, href)}
                />
              )
            })}
          </MediaGrid>
        )}
      </div>
    </div>
  )
}
