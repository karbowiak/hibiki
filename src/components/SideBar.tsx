import { Button } from "./shared/Button"
import { youtubeMusicContext } from "../backends/ytmusic/contextActions"
import "../styles/shellArtwork.css"
import "../styles/sidebar.css"
import { loadAlbumTracks } from "../lib/albumContents"
import { DownloadBadge } from "./shared/DownloadBadge"
import { useAccentStore } from "../stores/accentStore"
import { useArtworkAppearanceStore } from "../stores/artworkAppearanceStore"
import { ArtworkImage } from "./shared/ArtworkImage"
import { Link, useLocation } from "wouter"
import { Fragment, useRef, useState, useEffect } from "react"
import { useVirtualWindow, virtualRef } from "../hooks/useVirtualWindow"
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
import { IS_MACOS } from "../lib/platform"
import { useProviderMutationOwner } from "../hooks/useProviderMutationOwner"
import { useContextMenu } from "../hooks/useContextMenu"
import { useCapability } from "../hooks/useCapability"
import { useProviderStore } from "../stores/providerStore"
import { useDragStore } from "../stores/dragStore"
import type { MusicPlaylist } from "../types/music"
import { useLibraryPlaylists, libraryPlaylistHref, type LibraryPlaylist } from "../hooks/useLibraryPlaylists"
import { savePlaylistOrder } from "../stores/playlistOrder"
import { youtubeMusicCollectionSource, useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import { MusicSourceBadge } from "./shared/MusicSource"
import { IconChevronRight, IconServer } from "@tabler/icons-react"
import { useMixedPlaylistStore } from "../stores/mixedPlaylistStore"
import { playMixedPlaylist } from "../mixedPlaylists/playback"
import { captureMusicOwner } from "../mixedPlaylists/counterparts"
import { youtubeMusicSongMetadata } from "../backends/ytmusic/metadata"

// ---------------------------------------------------------------------------
// Custom order persistence (localStorage)
// ---------------------------------------------------------------------------

const LIBRARY_EXPANDED_KEY = "plex-sidebar-library-expanded"

function ServerLibraryNavigation() {
  const [location] = useLocation()
  const active = location === "/server-library" || location.startsWith("/server-library/")
  const [expanded, setExpanded] = useState(active)
  useEffect(() => { setExpanded(active) }, [location, active])
  return <li>
    <div className={clsx("flex items-center rounded-md", active && "shell-nav-active bg-accent-tint-strong text-accent")}>
      <Link href="/server-library" aria-current={location === "/server-library" ? "page" : undefined}
        className="shell-nav-link sidebar-nav-link flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 text-(--text-secondary) no-underline hover:bg-accent-tint hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
        <IconServer size={20} aria-hidden="true" /><span className="truncate">Server Library</span>
      </Link>
      <Button variant="bare" size="icon" aria-label={expanded ? "Collapse Server Library" : "Expand Server Library"}
        aria-expanded={expanded} aria-controls="sidebar-server-library-links" onClick={() => setExpanded(previous => !previous)} className="mr-1 shrink-0 rounded-md text-(--text-secondary) hover:bg-accent-tint">
        <IconChevronRight size={16} className={expanded ? "rotate-90" : ""} aria-hidden="true" />
      </Button>
    </div>
    {expanded && <ul id="sidebar-server-library-links" className="sidebar-library-links mb-2 ml-8 mt-1 space-y-0.5 text-sm font-normal">
      {["Artists", "Albums", "Songs"].map(title => {
        const href = `/server-library/${title.toLowerCase()}`
        return <li key={href}><Link href={href} aria-current={location === href ? "page" : undefined}
          className={clsx("shell-nav-link flex h-8 items-center rounded px-2 no-underline transition-colors hover:bg-accent-tint hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
            location === href ? "shell-nav-active bg-accent-tint-strong text-accent" : "text-(--text-secondary)")}>{title}</Link></li>
      })}
    </ul>}
  </li>
}

// ---------------------------------------------------------------------------
// Sortable playlist item
// ---------------------------------------------------------------------------

interface SortablePlaylistItemProps {
  rowRef?: React.RefObject<HTMLLIElement | null>
  playlist: LibraryPlaylist
  location: string
  playPlaylist: (
    playlistId: string,
    count: number,
    title: string,
    href: string
  ) => void
  ctxMenu: (
    type: "playlist",
    data: MusicPlaylist
  ) => (e: React.MouseEvent) => void
  justDragged: React.RefObject<boolean>
}

function SortablePlaylistItem({
  playlist,
  location,
  playPlaylist,
  ctxMenu,
  justDragged,
  rowRef,
}: SortablePlaylistItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: playlist.id,
  })
  const offline = useProviderStore((state) => state.provider?.isOffline)
  const youtubeConnected = useYoutubeMusicDiscoveryStore(state => state.connected)
  const isDropTarget = !playlist.smart && (playlist.mixed?.local || (playlist.youtubeMusic ? youtubeConnected && playlist.youtubeMusic.id.startsWith("VLPL") : !offline))
  const { actionsHandler } = useContextMenu()
  const [, navigate] = useLocation()
  // Subscribe to hover state from pointer-based drag system
  const isHovered = useDragStore(
    (s) => s.isDragging && s.hoveredPlaylistId === playlist.id
  )
  const [dropFlash, setDropFlash] = useState<"success" | "error" | null>(null)

  // Listen for media-drop custom events targeted at this playlist
  useEffect(() => {
    if (!isDropTarget) return
    let flashTimer: ReturnType<typeof setTimeout> | null = null
    function onDrop(e: Event) {
      const { targetPlaylistId, success } = (e as CustomEvent).detail
      if (targetPlaylistId !== playlist.id) return
      setDropFlash(success ? "success" : "error")
      if (flashTimer) clearTimeout(flashTimer)
      flashTimer = setTimeout(() => setDropFlash(null), 1000)
    }
    window.addEventListener("plexify-playlist-drop-result", onDrop)
    return () => {
      window.removeEventListener("plexify-playlist-drop-result", onDrop)
      if (flashTimer) clearTimeout(flashTimer)
    }
  }, [isDropTarget, playlist.id])

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    pointerEvents: isDragging ? "none" : undefined,
  }

  const href = libraryPlaylistHref(playlist)
  const artUrl = playlist.thumbUrl

  return (
    <li
      ref={(node) => {
        setNodeRef(node)
        if (rowRef) rowRef.current = node
      }}
      style={style}
      {...attributes}
      {...listeners}
      data-playlist-drop-target={isDropTarget ? playlist.id : undefined}
    >
      <Link
        href={href}
        aria-current={location === href ? "page" : undefined}
        onClick={(e) => {
          if (justDragged.current) {
            e.preventDefault()
            e.stopPropagation()
          }
        }}
        onContextMenu={playlist.mixed ? actionsHandler({ title: playlist.title, owner: playlist.mixed, actions: [
          { label: "Play", icon: "play", run: () => playMixedPlaylist(playlist.mixed!) },
          { label: "Match and sync", run: () => useMixedPlaylistStore.getState().sync(playlist.mixed!.id, true) },
        ] }) : playlist.youtubeMusic ? actionsHandler(youtubeMusicContext(playlist.youtubeMusic, navigate)) : ctxMenu("playlist", playlist)}
        className={clsx(
          "sidebar-playlist-link group flex cursor-default items-center gap-3 rounded-md px-1 py-[5px] no-underline transition-colors duration-200 hover:bg-accent-tint hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
          location !== href
            ? "text-(--text-secondary)"
            : "bg-accent-tint-strong text-(--text-primary)",
          isHovered && isDropTarget && "bg-accent/10 ring-2 ring-accent/60",
          dropFlash === "success" && "bg-green-500/10 ring-2 ring-green-500/60",
          dropFlash === "error" && "bg-red-500/10 ring-2 ring-red-500/60"
        )}
      >
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded bg-app-surface">
          {artUrl && (
            <ArtworkImage
              loading="eager"
              src={artUrl}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          )}
          <Button
            variant="bare"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (playlist.mixed) { void playMixedPlaylist(playlist.mixed); return }
              void playPlaylist(
                playlist.id,
                playlist.trackCount,
                playlist.title,
                href
              )
            }}
            title={`Play ${playlist.title}`}
            disabled={!playlist.youtubeMusic && !!offline && playlist.offlineAvailable !== true}
            className="absolute inset-0 flex items-center justify-center border-0 bg-overlay-medium opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="white">
              <polygon points="3,2 13,8 3,14" />
            </svg>
          </Button>
        </div>
        <span
          title={playlist.title}
          className="sidebar-playlist-title min-w-0 flex-1 truncate text-sm font-normal"
        >
          {playlist.title}
        </span>
        {playlist.youtubeMusic ? <MusicSourceBadge source="ytmusic" className="mr-1" /> : <DownloadBadge
          intentOnly
          kind="playlist"
          id={playlist.id}
          className="mr-1"
        />}
      </Link>
    </li>
  )
}

// ---------------------------------------------------------------------------
// SideBar
// ---------------------------------------------------------------------------

export function SideBar({
  onCreatePlaylist,
}: {
  onCreatePlaylist: () => void
}) {
  const savedAccent = useAccentStore((s) => s.accent)
  const backgroundArtworkEnabled = useArtworkAppearanceStore(
    (state) => state.backgroundArtworkEnabled
  )
  const [location] = useLocation()
  const hasStations = useCapability("stations")
  const { playlists: sortedPlaylists, youtube: youtubePlaylists } = useLibraryPlaylists()
  const playPlexPlaylist = usePlayerStore(useShallow((s) => s.playPlaylist))
  const playPlaylist = (id: string, count: number, title: string, href: string) => {
    if (id.startsWith("ytmusic:")) {
      if (useYoutubeMusicDiscoveryStore.getState().connected)
        void usePlayerStore.getState().playPagedTracks(youtubeMusicCollectionSource({ browseId: id.slice(8) }), title, href)
    } else void playPlexPlaylist(id, count, title, href)
  }
  const isArtExpanded = useUIStore((s) => s.isArtExpanded)
  const { handler: ctxMenu } = useContextMenu()
  const provider = useProviderStore((s) => s.provider)
  const captureOwner = useProviderMutationOwner(provider)

  // Handle media drops (tracks, albums, artists) from the pointer-based drag system
  useEffect(() => {
    let active = true
    const current = () =>
      active && useProviderStore.getState().provider === provider
    async function onDrop(e: Event) {
      const {
        payload,
        targetPlaylistId,
        provider: sourceProvider,
        scope,
        admission,
      } = (e as CustomEvent).detail
      const owned = captureOwner()
      const capturedScope = provider?.cacheScope
      const currentRequest = () =>
        current() && owned() && provider?.cacheScope === capturedScope
      if (!targetPlaylistId || !current()) return
      const target = sortedPlaylists.find(playlist => playlist.id === targetPlaylistId && !playlist.smart)
      if (!target) return
      const ownsTarget = () => target.mixed?.local ? current() : currentRequest()
      if (!ownsTarget()) return
      if (target.mixed || target.youtubeMusic || (payload.type === "track" && payload.ids.some((id: string) => id.startsWith("ytmusic:")))) {
        const owner = captureMusicOwner()
        try {
          if (sourceProvider !== undefined && (sourceProvider !== provider || scope !== capturedScope)) return
          if (payload.type !== "track") throw Error("Open the collection and drag its songs into this mixed playlist.")
          const tracks = []
          for (let index = 0; index < payload.ids.length; index++) {
            const id = payload.ids[index]
            const cached = payload.tracks?.[index]
            tracks.push(cached?.id === id ? cached : id.startsWith("ytmusic:") ? await youtubeMusicSongMetadata(id) : await provider!.getTrack(id))
            if (!owner.current() || !ownsTarget()) return
          }
          await useMixedPlaylistStore.getState().append(target.mixed?.id ?? targetPlaylistId, tracks, admission ?? crypto.randomUUID())
          if (owner.current() && ownsTarget()) window.dispatchEvent(new CustomEvent("plexify-playlist-drop-result", { detail: { targetPlaylistId, success: true } }))
        } catch (failure) {
          if (owner.current() && ownsTarget()) {
            useLibraryStore.setState({ error: String(failure instanceof Error ? failure.message : failure) })
            window.dispatchEvent(new CustomEvent("plexify-playlist-drop-result", { detail: { targetPlaylistId, success: false } }))
          }
        }
        return
      }
      if (!provider) return
      if (
        sourceProvider !== undefined &&
        (sourceProvider !== provider || scope !== capturedScope)
      )
        return
      if (
        !useLibraryStore
          .getState()
          .playlists.some((p) => p.id === targetPlaylistId && !p.smart)
      )
        return

      let accepted = false
      try {
        // A server album URI only resolves one physical copy. Expand the same
        // logical album used by its page; append track IDs in order.
        let itemIds: string[] = payload.ids
        if (payload.type === "album") {
          const tracks: string[] = []
          for (const albumId of itemIds) {
            if (!currentRequest()) return
            const items = await loadAlbumTracks(provider, albumId)
            if (!currentRequest()) return
            tracks.push(...items.map((track) => track.id))
          }
          itemIds = [...new Set(tracks)]
        }
        if (
          (payload.type === "track" || payload.type === "album") &&
          itemIds.length > 1
        ) {
          for (const id of itemIds) {
            if (!currentRequest()) return
            await provider.addToPlaylist(targetPlaylistId, [id])
            accepted = true
          }
        } else if (itemIds.length > 0) {
          await provider.addToPlaylist(targetPlaylistId, itemIds)
          accepted = true
        }
        if (!currentRequest()) return
        useLibraryStore.getState().invalidatePlaylistItems(targetPlaylistId)
        window.dispatchEvent(
          new window.CustomEvent("plexify-playlist-drop-result", {
            detail: { targetPlaylistId, success: true },
          })
        )
      } catch (err) {
        if (currentRequest()) {
          if (accepted)
            useLibraryStore.getState().invalidatePlaylistItems(targetPlaylistId)
          window.dispatchEvent(
            new window.CustomEvent("plexify-playlist-drop-result", {
              detail: { targetPlaylistId, success: false },
            })
          )
          useLibraryStore.setState({
            error: "Unable to add items to the playlist. Please try again.",
          })
        }
      }
    }
    window.addEventListener("plexify-media-drop", onDrop)
    return () => {
      active = false
      window.removeEventListener("plexify-media-drop", onDrop)
    }
  }, [provider, captureOwner, sortedPlaylists])

  const { width, onMouseDown } = useResizable({
    key: "plex-sidebar-width",
    defaultWidth: 240,
    minWidth: 160,
    maxWidth: 480,
    direction: "right",
  })

  // DnD sensors — require 5px movement to start drag (prevents accidental drags on clicks)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )
  const justDragged = useRef(false)
  const [libraryExpanded, setLibraryExpanded] = useState(() => {
    try {
      return localStorage.getItem(LIBRARY_EXPANDED_KEY) === "true"
    } catch {
      return false
    }
  })

  const playlistScroll = useRef<HTMLDivElement>(null)
  const playlistWindow = useVirtualWindow(
    sortedPlaylists.length,
    50,
    1,
    sortedPlaylists.length > 100,
    playlistScroll
  )
  const visiblePlaylists = sortedPlaylists.slice(
    playlistWindow.start,
    playlistWindow.end
  )

  function handleDragStart() {
    justDragged.current = true
  }

  function handleDragEnd(event: DragEndEvent) {
    // Keep justDragged true long enough to swallow the click that fires after pointer-up.
    // rAF is unreliable — the click can land 1-2 frames later depending on the browser.
    setTimeout(() => {
      justDragged.current = false
    }, 300)

    const { active, over } = event
    if (!over || active.id === over.id) return

    const ids = sortedPlaylists.map((p) => p.id)
    const oldIdx = ids.indexOf(String(active.id))
    const newIdx = ids.indexOf(String(over.id))
    if (oldIdx === -1 || newIdx === -1) return

    const reordered = [...ids]
    const [moved] = reordered.splice(oldIdx, 1)
    reordered.splice(newIdx, 0, moved)
    savePlaylistOrder(reordered)
  }

  return (
    <nav
      role="navigation"
      aria-label="Main navigation"
      data-shell-transparency={backgroundArtworkEnabled ? "enabled" : undefined}
      className="app-sidebar shell-artwork-surface relative flex h-full shrink-0 flex-col bg-app-bg"
      style={{
        width,
        padding: "var(--spacing-sidebar)",
        ...(IS_MACOS && { paddingTop: "max(var(--spacing-sidebar), 28px)" }),
      }}
    >
      {/* Resize handle */}
      <div
        className="absolute bottom-0 right-0 top-0 z-10 w-1 cursor-ew-resize transition-colors hover:bg-white/10"
        onMouseDown={onMouseDown}
      />
      <ul className="sidebar-navigation shrink-0 pt-1 text-sm font-medium">
        {routes1
          .filter((i) => i.href !== "/stations" || hasStations)
          .map((i, index) => {
            const isActive =
              i.href === "/library"
                ? location === "/library" || location.startsWith("/collection/")
                : location === i.href
            return (
              <Fragment key={`${i.href}-${index}`}><li>
                <div
                  className={clsx(
                    "sidebar-nav-row flex items-center rounded-md",
                    isActive && "shell-nav-active bg-accent-tint-strong"
                  )}
                >
                  <Link
                    href={i.href}
                    aria-current={location === i.href ? "page" : undefined}
                    className={clsx(
                      "shell-nav-link sidebar-nav-link flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded px-3 no-underline transition-colors duration-200 hover:bg-accent-tint hover:fill-(--text-primary) hover:text-(--text-primary) hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                      !isActive
                        ? "fill-(--text-secondary) text-(--text-secondary)"
                        : "fill-accent text-accent"
                    )}
                  >
                    <svg
                      height="20"
                      width="20"
                      viewBox="0 0 24 24"
                      className="shrink-0"
                    >
                      {!isActive ? i.icon : i.iconActive}
                    </svg>
                    <span className="truncate">{i.title}</span>
                  </Link>
                  {i.href === "/library" && (
                    <Button
                      variant="bare"
                      aria-label={
                        libraryExpanded ? "Collapse library" : "Expand library"
                      }
                      aria-expanded={libraryExpanded}
                      aria-controls="sidebar-library-links"
                      onClick={() =>
                        setLibraryExpanded((prev) => {
                          const next = !prev
                          try {
                            localStorage.setItem(
                              LIBRARY_EXPANDED_KEY,
                              String(next)
                            )
                          } catch {}
                          return next
                        })
                      }
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded border-0 bg-transparent text-(--text-secondary) transition-colors hover:bg-accent-tint hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className={clsx(
                          "transition-transform duration-200",
                          libraryExpanded && "rotate-90"
                        )}
                      >
                        <path d="M6 3l5 5-5 5z" />
                      </svg>
                    </Button>
                  )}
                </div>
                {i.href === "/library" && libraryExpanded && (
                  <ul
                    id="sidebar-library-links"
                    className="sidebar-library-links mb-2 ml-8 mt-1 space-y-0.5 text-sm font-normal"
                  >
                    {librarySubLinks.map((sub) => (
                      <li key={sub.href}>
                        <Link
                          href={sub.href}
                          aria-current={
                            location === sub.href ? "page" : undefined
                          }
                          className={clsx(
                            "shell-nav-link flex h-8 items-center rounded px-2 no-underline transition-colors duration-200 hover:bg-accent-tint hover:text-(--text-primary) hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                            location === sub.href
                              ? "shell-nav-active bg-accent-tint-strong text-accent"
                              : "text-(--text-secondary)"
                          )}
                        >
                          {sub.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>{i.href === "/library" && <ServerLibraryNavigation />}</Fragment>
            )
          })}
      </ul>

      <div className="sidebar-create-wrap shrink-0 pb-1 pt-4 text-sm font-medium">
        <Button
          variant="bare"
          onClick={onCreatePlaylist}
          style={
            { "--playlist-create-accent": savedAccent } as React.CSSProperties
          }
          className="sidebar-create group flex w-full items-center gap-3 rounded-md px-3 text-(--text-primary) transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="sidebar-create-icon flex h-5 w-5 items-center justify-center">
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5z" fill="currentColor"></path>
              <path fill="none" d="M0 0h16v16H0z"></path>
            </svg>
          </span>
          <span>Create Playlist</span>
        </Button>
      </div>

      <div className="sidebar-playlists-heading">
        <span>Playlists</span>
        <span aria-label={`${sortedPlaylists.length} playlists`}>
          {sortedPlaylists.length}
        </span>
      </div>
      <div
        ref={playlistScroll}
        className="sidebar-playlists scrollbar-track-(--bg-base) scrollbar-thumb-(--bg-surface) hover:scrollbar-thumb-(--bg-surface-hover) mt-2 min-h-0 flex-1 overflow-y-scroll scrollbar scrollbar-w-1"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() =>
            setTimeout(() => {
              justDragged.current = false
            }, 300)
          }
        >
          <SortableContext
            items={visiblePlaylists.map((p) => p.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul
              className="pt-1"
              ref={virtualRef<HTMLUListElement>(playlistWindow.host)}
            >
              {playlistWindow.before > 0 && (
                <li
                  aria-hidden="true"
                  style={{ height: playlistWindow.before }}
                />
              )}
              {visiblePlaylists.map((playlist, index) => (
                <SortablePlaylistItem
                  key={playlist.id}
                  rowRef={
                    index === 0
                      ? virtualRef<HTMLLIElement>(playlistWindow.measure)
                      : undefined
                  }
                  playlist={playlist}
                  location={location}
                  playPlaylist={playPlaylist}
                  ctxMenu={ctxMenu}
                  justDragged={justDragged}
                />
              ))}
              {playlistWindow.after > 0 && (
                <li
                  aria-hidden="true"
                  style={{ height: playlistWindow.after }}
                />
              )}
              {youtubePlaylists.connected && (youtubePlaylists.more || youtubePlaylists.error) && <li>
                <Button variant="bare" type="button" disabled={youtubePlaylists.loading} onClick={() => void (youtubePlaylists.error ? youtubePlaylists.retry() : youtubePlaylists.loadMore())}
                  className="px-3 py-2 text-xs text-(--text-secondary)">{youtubePlaylists.error ? "Retry YTM playlists" : youtubePlaylists.loading ? "Loading YTM playlists…" : "More YTM playlists"}</Button>
              </li>}
            </ul>
          </SortableContext>
        </DndContext>
      </div>
      {/* Spacer to push sidebar content up when expanded art covers the bottom-left corner.
          The expanded art is (sidebarWidth × sidebarWidth), overlapping the player bar (h-24 = 96px). */}
      {isArtExpanded && (
        <div
          className="shrink-0 transition-all duration-300"
          style={{ height: width - 120 }}
        />
      )}
    </nav>
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

const librarySubLinks = [
  { title: "Playlists", href: "/collection/playlists" },
  { title: "Liked Songs", href: "/collection/tracks" },
  { title: "Liked Albums", href: "/collection/albums" },
  { title: "Liked Artists", href: "/collection/artists" },
]
