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
            <p className="mt-2 max-w-xl select-text text-sm text-gray-400">
              All your playlists in one place.
            </p>
          </div>
          <p className="text-sm text-gray-400">
            {count.toLocaleString()} {count === 1 ? "playlist" : "playlists"}
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
                      aria-label={`Play ${pl.title}`}
                      className="absolute bottom-2 right-2 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-black shadow-lg opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none transition-all hover:scale-105"
                    >
                      <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                        <polygon points="3,2 13,8 3,14" />
                      </svg>
                    </button>
                  </div>
                  <div className="w-full min-w-0">
                    <div className="truncate font-semibold text-sm text-white">
                      {pl.title}
                    </div>
                    <div className="truncate text-xs text-gray-400">
                      {pl.trackCount.toLocaleString()} {pl.trackCount === 1 ? "song" : "songs"}
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
