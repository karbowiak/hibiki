import { ArtworkImage } from "../shared/ArtworkImage"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore } from "../../stores"
import { usePlayerStore } from "../../stores/playerStore"
import { useContextMenu } from "../../hooks/useContextMenu"
import { MediaGrid } from "../shared/MediaGrid"
import { Link } from "wouter"

export function Playlists() {
  const playlists = useLibraryStore(s => s.playlists)
  const playPlaylist = usePlayerStore(useShallow(s => s.playPlaylist))
  const { handler: ctxMenu } = useContextMenu()

  const count = playlists.length

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="flex flex-wrap items-end gap-6 p-8">
        <div className="flex w-60 h-60 flex-shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-indigo-700 to-purple-500 shadow-2xl">
          <svg viewBox="0 0 24 24" width="80" height="80" fill="white">
            <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
          </svg>
        </div>

        <div className="flex min-w-0 flex-[1_1_20rem] flex-col justify-between gap-4 self-stretch">
          <div>
            <div className="break-words text-[76px] font-black leading-none">
              Playlists
            </div>
            <p className="mt-2 max-w-xl select-text text-sm text-gray-400">
              All your playlists in one place.
            </p>
          </div>
          <p className="text-sm text-gray-400">
            {count} {count === 1 ? "playlist" : "playlists"}
          </p>
        </div>
      </div>

      {/* Playlist grid */}
      <div className="px-8 pt-2">
        {count === 0 ? (
          <div className="py-12 text-center text-sm text-gray-500">
            No playlists yet. Create one to get started.
          </div>
        ) : (
          <MediaGrid>
            {playlists.map(pl => {
              const href = `/playlist/${pl.id}`
              return (
                <Link
                  key={pl.id}
                  href={href}
                  onContextMenu={ctxMenu("playlist", pl)}
                  className="group flex flex-col gap-2 rounded-md p-3 no-underline transition-colors hover:bg-hl-card"
                >
                  <div className="relative w-full aspect-square overflow-hidden rounded-md bg-app-surface shadow-lg">
                    {pl.thumbUrl ? (
                      <ArtworkImage
                        src={pl.thumbUrl}
                        alt={pl.title}
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <svg viewBox="0 0 24 24" width="40" height="40" fill="#535353">
                          <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
                        </svg>
                      </div>
                    )}
                    <button
                      onClick={e => {
                        e.preventDefault()
                        e.stopPropagation()
                        void playPlaylist(pl.id, pl.trackCount, pl.title, href)
                      }}
                      title={`Play ${pl.title}`}
                      className="absolute inset-0 flex items-center justify-center bg-overlay-medium opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none transition-opacity"
                    >
                      <svg viewBox="0 0 16 16" width="24" height="24" fill="white">
                        <polygon points="3,2 13,8 3,14" />
                      </svg>
                    </button>
                  </div>
                  <div className="w-full min-w-0">
                    <div className="truncate font-semibold text-sm text-white">
                      {pl.title}
                    </div>
                    <div className="truncate text-xs text-gray-400">
                      {pl.trackCount} {pl.trackCount === 1 ? "song" : "songs"}
                    </div>
                  </div>
                </Link>
              )
            })}
          </MediaGrid>
        )}
      </div>
    </div>
  )
}
