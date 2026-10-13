import { useEffect, useRef } from "react"
import { makeOnPlay } from "../lib/mediaPlay"
import { usePlayerStore } from "../stores/playerStore"
import { DownloadBadge } from "./shared/DownloadBadge"
import { useProviderStore } from "../stores/providerStore"
import {
  useContextMenuStore,
  type ContextAction,
} from "../stores/contextMenuStore"
import { ArtworkImage, useArtworkFailures } from "./shared/ArtworkImage"
import { Link } from "wouter"
import clsx from "clsx"
import { useTrackDrag } from "../hooks/useTrackDrag"
import { useArtistImage, useAlbumImage } from "../hooks/useMediaImage"
import { useContextMenu } from "../hooks/useContextMenu"
import type { MusicItem } from "../types/music"
import type { DragPayload } from "../stores/dragStore"

interface MediaCardProps {
  title: string
  desc: string
  thumb: string | null
  /** Fallback image URL shown when `thumb` is null (e.g. an image:// cached external URL). */
  thumbFallback?: string | null
  onImageFailure?: (url: string) => void
  isArtist?: boolean
  /** When true, fixes card at 160px wide and prevents flex shrink (for scroll rows) */
  scrollItem?: boolean
  /** When true (with scrollItem), renders card ~33% larger at 213px */
  large?: boolean
  href?: string
  onClick?: () => void
  /** Called once on first hover — used for eager pre-fetching of page data. */
  prefetch?: () => void
  /** When provided, shows a play button overlay on hover. Called on click. */
  onPlay?: (e: React.MouseEvent) => void
  onContextMenu?: (e: React.MouseEvent) => void
  /** Actual provider media only; synthetic stations and public feeds omit it. */
  contextItem?: MusicItem
  /** Ephemeral actions for generated mixes/stations, without library IDs. */
  contextActions?: readonly ContextAction[]
  /** When provided, enables dragging this card to playlists/queue. */
  dragPayload?: DragPayload
  /** Artist name — enables priority-aware image resolution from external sources. */
  artistName?: string | null
  /** Album name — enables priority-aware album image resolution (requires artistName too). */
  albumName?: string | null
  versionCount?: number
  onViewVersions?: () => void
}

/**
 * Resolves the best image for an artist card via the priority metadata system.
 * Separate component to satisfy React's rules of hooks.
 */
function ArtistImageCard({
  artistName,
  thumb,
  ...rest
}: MediaCardProps & { artistName: string }) {
  const { failures, onFailure } = useArtworkFailures(
    JSON.stringify([artistName, thumb])
  )
  const resolved = useArtistImage(artistName, thumb, undefined, failures)
  return (
    <MediaCardInner {...rest} thumb={resolved} onImageFailure={onFailure} />
  )
}

/**
 * Resolves the best image for an album card via the priority metadata system.
 * Separate component to satisfy React's rules of hooks.
 */
function AlbumImageCard({
  artistName,
  albumName,
  thumb,
  ...rest
}: MediaCardProps & { artistName: string; albumName: string }) {
  const { failures, onFailure } = useArtworkFailures(
    JSON.stringify([artistName, albumName, thumb])
  )
  const resolved = useAlbumImage(
    artistName,
    albumName,
    thumb,
    undefined,
    failures
  )
  return (
    <MediaCardInner {...rest} thumb={resolved} onImageFailure={onFailure} />
  )
}

export function MediaCard(props: MediaCardProps) {
  const { artistName, albumName } = props
  // When artistName is provided, use priority-aware image resolution
  if (artistName) {
    if (props.isArtist) {
      return <ArtistImageCard {...props} artistName={artistName} />
    }
    if (albumName) {
      return (
        <AlbumImageCard
          {...props}
          artistName={artistName}
          albumName={albumName}
        />
      )
    }
  }
  return <MediaCardInner {...props} />
}

function MediaCardInner({
  title,
  desc,
  thumb,
  thumbFallback,
  scrollItem,
  large,
  href,
  onClick,
  prefetch,
  onPlay,
  onContextMenu,
  dragPayload,
  onImageFailure,
  contextItem,
  contextActions,
  versionCount,
  onViewVersions,
}: MediaCardProps) {
  const { handler, actionsHandler } = useContextMenu()
  const offline = useProviderStore((state) => state.provider?.isOffline)
  const unavailable =
    !!offline &&
    !!contextItem &&
    (contextItem.type === "track"
      ? contextItem.mediaInfo?.offlineAvailable !== true
      : contextItem.offlineAvailable !== true)
  const menuOwner = useRef({})
  useEffect(
    () => () => {
      const menu = useContextMenuStore.getState()
      if (
        menu.type === "actions" &&
        menu.data &&
        "owner" in menu.data &&
        menu.data.owner === menuOwner.current
      )
        menu.close()
    },
    [title, href]
  )
  const contextHandler =
    onContextMenu ??
    (contextItem
      ? handler(contextItem.type, contextItem)
      : contextActions?.length
        ? actionsHandler({
            title,
            owner: menuOwner.current,
            actions: contextActions,
          })
        : undefined)
  const displayThumb = thumb || thumbFallback || null
  const trackDrag = useTrackDrag()
  const scrollStyle = scrollItem
    ? {
        width: large
          ? "calc(var(--card-size, 160px) * 1.33)"
          : "var(--card-size, 160px)",
      }
    : undefined

  const dragHandlers = dragPayload
    ? {
        onPointerDown: (e: React.PointerEvent) =>
          trackDrag.onPointerDown(e, dragPayload),
        onPointerMove: trackDrag.onPointerMove,
        onPointerUp: trackDrag.onPointerUp,
      }
    : undefined

  const initials = title
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase()
  const cardContent = (
    <>
      <div className="media-card__art aspect-square">
        {displayThumb ? (
          <ArtworkImage
            onFailure={onImageFailure}
            src={displayThumb}
            alt={title}
            draggable={false}
            loading="lazy"
            className="media-card__image"
          />
        ) : (
          <div className="media-card__fallback" aria-hidden="true">
            <span>{initials}</span>
          </div>
        )}
      </div>
      <div className="media-card__gradient" aria-hidden="true" />
      {onViewVersions && (versionCount ?? 0) > 1 && (
        <button
          type="button"
          className="media-card__versions"
          aria-label={`Compare ${versionCount} versions of ${title}`}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onViewVersions()
          }}
        >
          {versionCount} versions
        </button>
      )}
      <div
        className={clsx(
          "media-card__caption",
          onPlay && "media-card__caption--play"
        )}
      >
        <div className="media-card__title" title={title}>
          {title}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="media-card__meta min-w-0" title={desc}>
            {desc}
          </div>
          {contextItem && (
            <DownloadBadge
              kind={contextItem.type}
              id={contextItem.id}
              className="!text-white"
            />
          )}
        </div>
      </div>
      {onPlay && (
        <button
          type="button"
          disabled={unavailable}
          title={
            unavailable
              ? "Download this music while connected to play offline"
              : undefined
          }
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (unavailable) return
            if (offline && contextItem) {
              makeOnPlay(contextItem, {
                ...usePlayerStore.getState(),
                provider: useProviderStore.getState().provider,
              })?.()
            } else onPlay(e)
          }}
          aria-label={`Play ${title}`}
          className="media-card__play"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="currentColor"
          >
            <polygon points="3,2 13,8 3,14" />
          </svg>
        </button>
      )}
    </>
  )

  const cardClass = clsx(
    "media-card group",
    scrollItem && "flex-shrink-0",
    unavailable && "media-card--unavailable"
  )
  const primaryClass = "media-card__primary"
  return (
    <div
      style={scrollStyle}
      onMouseEnter={prefetch}
      onFocus={prefetch}
      onContextMenu={contextHandler}
      onKeyDown={
        contextHandler
          ? (e) => {
              if (
                e.repeat ||
                e.nativeEvent.isComposing ||
                e.altKey ||
                e.ctrlKey ||
                e.metaKey
              )
                return
              if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey))
                return
              e.preventDefault()
              e.stopPropagation()
              const bounds = e.currentTarget.getBoundingClientRect()
              e.currentTarget.dispatchEvent(
                new window.MouseEvent("contextmenu", {
                  bubbles: true,
                  cancelable: true,
                  clientX: bounds.left,
                  clientY: bounds.bottom,
                })
              )
            }
          : undefined
      }
      className={cardClass}
      {...(!href && !onClick ? dragHandlers : undefined)}
    >
      {href ? (
        <Link
          href={href}
          onClick={onClick}
          aria-label={title}
          draggable={false}
          className={primaryClass}
          {...dragHandlers}
        />
      ) : onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={title}
          className={primaryClass}
          {...dragHandlers}
        />
      ) : null}
      {cardContent}
    </div>
  )
}
