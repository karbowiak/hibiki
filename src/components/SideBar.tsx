import { Link, useLocation } from "wouter"
import { useMemo, useRef, useState } from "react"
import clsx from "clsx"
import { useShallow } from "zustand/react/shallow"
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { useLibraryStore } from "../stores"
import { usePlayerStore } from "../stores/playerStore"
import { useUIStore } from "../stores/uiStore"
import { useResizable } from "../hooks/useResizable"
import { useContextMenu } from "../hooks/useContextMenu"
import { useCapability } from "../hooks/useCapability"
import type { MusicPlaylist } from "../types/music"

// ---------------------------------------------------------------------------
// Custom order persistence (localStorage)
// ---------------------------------------------------------------------------

const ORDER_KEY = "plex-sidebar-playlist-order"

function getCustomOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function setCustomOrder(ids: string[]) {
  localStorage.setItem(ORDER_KEY, JSON.stringify(ids))
}

// ---------------------------------------------------------------------------
// Sortable playlist item
// ---------------------------------------------------------------------------

interface SortablePlaylistItemProps {
  playlist: MusicPlaylist
  location: string
  playPlaylist: (playlistId: string, count: number, title: string, href: string) => void
  ctxMenu: (type: "playlist", data: MusicPlaylist) => (e: React.MouseEvent) => void
  justDragged: React.RefObject<boolean>
}

function SortablePlaylistItem({ playlist, location, playPlaylist, ctxMenu, justDragged }: SortablePlaylistItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: playlist.id,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    // Prevent the browser from sending click events to the <Link> while dragging
    pointerEvents: isDragging ? "none" : undefined,
  }

  const href = `/playlist/${playlist.id}`
  const artUrl = playlist.thumbUrl

  return (
    <li ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <Link
        href={href}
        onClick={e => { if (justDragged.current) { e.preventDefault(); e.stopPropagation() } }}
        onContextMenu={ctxMenu("playlist", playlist)}
        className={clsx(
          "group flex cursor-default items-center gap-3 rounded-md px-1 py-[5px] no-underline hover:bg-app-surface hover:no-underline",
          location !== href ? "text-[color:var(--text-secondary)]" : "text-[color:var(--text-primary)]"
        )}
      >
        <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-app-surface">
          {artUrl && (
            <img src={artUrl} alt="" className="h-full w-full object-cover" draggable={false} />
          )}
          <button
            onClick={e => {
              e.preventDefault()
              e.stopPropagation()
              void playPlaylist(playlist.id, playlist.trackCount, playlist.title, href)
            }}
            title={`Play ${playlist.title}`}
            className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="white">
              <polygon points="3,2 13,8 3,14" />
            </svg>
          </button>
        </div>
        <span className="truncate text-sm font-normal">{playlist.title}</span>
      </Link>
    </li>
  )
}

// ---------------------------------------------------------------------------
// SideBar
// ---------------------------------------------------------------------------

export function SideBar({ onCreatePlaylist }: { onCreatePlaylist: () => void }) {
  const [location] = useLocation()
  const hasStations = useCapability("stations")
  const playlists = useLibraryStore(s => s.playlists)
  const playPlaylist = usePlayerStore(useShallow(s => s.playPlaylist))
  const isArtExpanded = useUIStore(s => s.isArtExpanded)
  const { handler: ctxMenu } = useContextMenu()
  const { width, onMouseDown } = useResizable({
    key: "plex-sidebar-width",
    defaultWidth: 240,
    minWidth: 160,
    maxWidth: 480,
    direction: "right",
  })

  // DnD sensors — require 5px movement to start drag (prevents accidental drags on clicks)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const [orderVersion, setOrderVersion] = useState(0)
  const justDragged = useRef(false)

  // Sort playlists by custom order; new playlists go to bottom
  const sortedPlaylists = useMemo(() => {
    const order = getCustomOrder()
    if (order.length === 0) return playlists

    const orderMap = new Map(order.map((id, idx) => [id, idx]))
    const inOrder = playlists
      .filter(p => orderMap.has(p.id))
      .sort((a, b) => orderMap.get(a.id)! - orderMap.get(b.id)!)
    const notInOrder = playlists.filter(p => !orderMap.has(p.id))
    return [...inOrder, ...notInOrder]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists, orderVersion])

  function handleDragStart() {
    justDragged.current = true
  }

  function handleDragEnd(event: DragEndEvent) {
    // Keep justDragged true long enough to swallow the click that fires after pointer-up.
    // rAF is unreliable — the click can land 1-2 frames later depending on the browser.
    setTimeout(() => { justDragged.current = false }, 300)

    const { active, over } = event
    if (!over || active.id === over.id) return

    const ids = sortedPlaylists.map(p => p.id)
    const oldIdx = ids.indexOf(String(active.id))
    const newIdx = ids.indexOf(String(over.id))
    if (oldIdx === -1 || newIdx === -1) return

    const reordered = [...ids]
    const [moved] = reordered.splice(oldIdx, 1)
    reordered.splice(newIdx, 0, moved)
    setCustomOrder(reordered)
    setOrderVersion(v => v + 1)
  }

  return (
    <div className="relative flex h-full flex-shrink-0 flex-col bg-app-bg p-6" style={{ width }}>
      {/* Resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1 cursor-ew-resize z-10 hover:bg-white/10 transition-colors"
        onMouseDown={onMouseDown}
      />
      <ul className="flex-shrink-0 pt-1 text-sm font-semibold">
        {routes1.filter(i => i.href !== "/stations" || hasStations).map((i, index) => (
          <li key={`${i.href}-${index}`}>
            <Link
              href={i.href}
              className={clsx(
                "flex h-10 cursor-pointer items-center gap-4 rounded no-underline transition-colors duration-300 hover:fill-[var(--text-primary)] hover:text-[var(--text-primary)] hover:no-underline",
                location !== i.href
                  ? "fill-gray-400 text-gray-400"
                  : "fill-accent text-accent"
              )}
            >
              <svg height="24" width="24" viewBox="0 0 24 24">
                {location !== i.href ? i.icon : i.iconActive}
              </svg>
              <span>{i.title}</span>
            </Link>
          </li>
        ))}
      </ul>

      <ul className="flex-shrink-0 border-b border-[var(--border)] pb-1 pt-8 text-sm font-semibold">
        {routes2.map((i, index) => (
          <li key={`${i.href}-${index}`}>
            {i.href === "/create" ? (
              <button
                onClick={onCreatePlaylist}
                className="flex h-10 w-full cursor-pointer items-center gap-4 rounded fill-gray-400 text-gray-400 transition-colors duration-300 hover:fill-[var(--text-primary)] hover:text-[var(--text-primary)]"
              >
                {i.icon}
                <span>{i.title}</span>
              </button>
            ) : (
              <Link
                href={i.href}
                className={clsx(
                  "flex h-10 cursor-pointer items-center gap-4 rounded no-underline transition-colors duration-300 hover:fill-[var(--text-primary)] hover:text-[var(--text-primary)] hover:no-underline",
                  location !== i.href
                    ? "fill-gray-400 text-gray-400"
                    : "fill-accent text-accent"
                )}
              >
                {i.icon}
                <span>{i.title}</span>
              </Link>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-2 min-h-0 flex-1 overflow-y-scroll scrollbar scrollbar-w-1 scrollbar-track-[var(--bg-base)] scrollbar-thumb-[var(--bg-surface)] hover:scrollbar-thumb-[var(--bg-surface-hover)]">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setTimeout(() => { justDragged.current = false }, 300)}>
          <SortableContext items={sortedPlaylists.map(p => p.id)} strategy={verticalListSortingStrategy}>
            <ul className="pt-1">
              {sortedPlaylists.map((playlist) => (
                <SortablePlaylistItem
                  key={playlist.id}
                  playlist={playlist}
                  location={location}
                  playPlaylist={playPlaylist}
                  ctxMenu={ctxMenu}
                  justDragged={justDragged}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </div>
      {/* Spacer to push sidebar content up when expanded art covers the bottom-left corner.
          The expanded art is (sidebarWidth × sidebarWidth), overlapping the player bar (h-24 = 96px). */}
      {isArtExpanded && (
        <div className="flex-shrink-0 transition-all duration-300" style={{ height: width - 120 }} />
      )}
    </div>
  )
}

const routes1 = [
  {
    title: "Home",
    href: "/",
    icon: (
      <path d="M12.5 3.247a1 1 0 0 0-1 0L4 7.577V20h4.5v-6a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6H20V7.577l-7.5-4.33zm-2-1.732a3 3 0 0 1 3 0l7.5 4.33a2 2 0 0 1 1 1.732V21a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-6h-3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.577a2 2 0 0 1 1-1.732l7.5-4.33z"></path>
    ),
    iconActive: (
      <path d="M13.5 1.515a3 3 0 0 0-3 0L3 5.845a2 2 0 0 0-1 1.732V21a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6h4v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7.577a2 2 0 0 0-1-1.732l-7.5-4.33z" />
    ),
  },
  {
    title: "Search",
    href: "/search",
    icon: (
      <path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z"></path>
    ),
    iconActive: (
      <path d="M1.126 10.558c0-5.14 4.226-9.28 9.407-9.28 5.18 0 9.407 4.14 9.407 9.28a9.157 9.157 0 0 1-2.077 5.816l4.344 4.344a1 1 0 0 1-1.414 1.414l-4.353-4.353a9.454 9.454 0 0 1-5.907 2.058c-5.18 0-9.407-4.14-9.407-9.28z"></path>
    ),
  },
  {
    title: "Your Library",
    href: "/library",
    icon: (
      <path d="M14.5 2.134a1 1 0 0 1 1 0l6 3.464a1 1 0 0 1 .5.866V21a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V3a1 1 0 0 1 .5-.866zM16 4.732V20h4V7.041l-4-2.309zM3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm6 0a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1z"></path>
    ),
    iconActive: (
      <path d="M3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zM15.5 2.134A1 1 0 0 0 14 3v18a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6.464a1 1 0 0 0-.5-.866l-6-3.464zM9 2a1 1 0 0 0-1 1v18a1 1 0 1 0 2 0V3a1 1 0 0 0-1-1z"></path>
    ),
  },
  {
    title: "Stations",
    href: "/stations",
    icon: (
      <path d="M12 2a8.997 8.997 0 0 1 7.663 4.267 1 1 0 1 1-1.697 1.06A6.998 6.998 0 0 0 5.034 7.327a1 1 0 1 1-1.697-1.06A8.997 8.997 0 0 1 12 2zM2.868 9.923a1 1 0 0 1 1.326.482A6.98 6.98 0 0 0 12 14.993a6.98 6.98 0 0 0 7.806-4.588 1 1 0 0 1 1.808.844A8.98 8.98 0 0 1 12 16.993a8.98 8.98 0 0 1-9.614-5.744 1 1 0 0 1 .482-1.326zM12 18a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm-4 1a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm8 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" />
    ),
    iconActive: (
      <path d="M12 2a8.997 8.997 0 0 1 7.663 4.267 1 1 0 1 1-1.697 1.06A6.998 6.998 0 0 0 5.034 7.327a1 1 0 1 1-1.697-1.06A8.997 8.997 0 0 1 12 2zM2.868 9.923a1 1 0 0 1 1.326.482A6.98 6.98 0 0 0 12 14.993a6.98 6.98 0 0 0 7.806-4.588 1 1 0 0 1 1.808.844A8.98 8.98 0 0 1 12 16.993a8.98 8.98 0 0 1-9.614-5.744 1 1 0 0 1 .482-1.326zM12 18a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm-4 1a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm8 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" />
    ),
  },
  {
    title: "Internet Radio",
    href: "/internet-radio",
    icon: (
      <path d="M4.002 5.5A1.5 1.5 0 0 1 5.502 4h13a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-13a1.5 1.5 0 0 1-1.5-1.5v-5zM12 2a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 12 2zM8.5 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM12 8.75a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5H12zm0-2a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5H12zM2.002 14.25a.75.75 0 0 1 .75-.75h18.5a.75.75 0 0 1 0 1.5H20v4.25a.75.75 0 0 1-1.5 0V15h-13v4.25a.75.75 0 0 1-1.5 0V15h-1.25a.75.75 0 0 1-.75-.75z" />
    ),
    iconActive: (
      <path d="M4.002 5.5A1.5 1.5 0 0 1 5.502 4h13a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-13a1.5 1.5 0 0 1-1.5-1.5v-5zM12 2a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 12 2zM8.5 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM12 8.75a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5H12zm0-2a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5H12zM2.002 14.25a.75.75 0 0 1 .75-.75h18.5a.75.75 0 0 1 0 1.5H20v4.25a.75.75 0 0 1-1.5 0V15h-13v4.25a.75.75 0 0 1-1.5 0V15h-1.25a.75.75 0 0 1-.75-.75z" />
    ),
  },
  {
    title: "Podcasts",
    href: "/podcasts",
    icon: (
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM6 10a1 1 0 1 0-2 0 8 8 0 0 0 7 7.93V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-3.07A8 8 0 0 0 20 10a1 1 0 1 0-2 0 6 6 0 0 1-12 0z" />
    ),
    iconActive: (
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM6 10a1 1 0 1 0-2 0 8 8 0 0 0 7 7.93V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-3.07A8 8 0 0 0 20 10a1 1 0 1 0-2 0 6 6 0 0 1-12 0z" />
    ),
  },
]

const routes2 = [
  {
    title: "Create Playlist",
    href: "/create",
    icon: (
      <span className="flex h-6 w-6 items-center justify-center rounded-sm bg-accent/20 text-accent group-hover:bg-accent/40 transition-colors">
        <svg viewBox="0 0 16 16" width="12" height="12" xmlns="http://www.w3.org/2000/svg">
          <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5z" fill="currentColor"></path>
          <path fill="none" d="M0 0h16v16H0z"></path>
        </svg>
      </span>
    ),
  },
  {
    title: "Liked Songs",
    href: "/collection/tracks",
    icon: (
      <svg height="24" width="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M15.724 4.22A4.313 4.313 0 0 0 12 6.192 4.313 4.313 0 0 0 8.276 4.22a4.313 4.313 0 0 0-4.204 4.32c0 3.96 4.49 7.98 7.928 10.47 3.44-2.49 7.928-6.51 7.928-10.47a4.313 4.313 0 0 0-4.204-4.32z" />
      </svg>
    ),
  },
  {
    title: "Liked Artists",
    href: "/collection/artists",
    icon: (
      <svg height="24" width="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
      </svg>
    ),
  },
  {
    title: "Liked Albums",
    href: "/collection/albums",
    icon: (
      <svg height="24" width="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
      </svg>
    ),
  },
]
